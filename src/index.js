export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/admin.html") {
			if (url.searchParams.get("key") !== env.ADMIN_KEY) {
				return new Response("Unauthorized", { status: 401 });
			}

			return env.ASSETS.fetch(request);
		}

		if (url.pathname === "/api/health") {
			return Response.json({ ok: true });
		}

		if (url.pathname === "/api/services") {
			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const { results } = await env.DB.prepare(
				`
					SELECT id, code, name, duration_minutes, price_cents, is_active
					FROM services
					WHERE is_active = 1
					ORDER BY duration_minutes ASC
				`
			).all();

			return Response.json(results ?? []);
		}

		if (url.pathname === "/api/availability") {
			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const serviceId = Number(url.searchParams.get("serviceId"));
			const date = url.searchParams.get("date");

			if (!Number.isInteger(serviceId) || !isIsoDate(date)) {
				return json({ error: "Invalid serviceId or date" }, 400);
			}

			const service = await env.DB.prepare(
				`
					SELECT id, duration_minutes
					FROM services
					WHERE id = ? AND is_active = 1
					LIMIT 1
				`
			)
				.bind(serviceId)
				.first();

			if (!service) {
				return json({ error: "Service not found" }, 404);
			}

			const settings = await getBookingSettings(env);
			const todayInHelsinki = getCurrentLocalDateString(TIMEZONE);

			if (date < todayInHelsinki) {
				return Response.json([]);
			}

			const weekday = getWeekdayNumber(date);
			const hours = await env.DB.prepare(
				`
					SELECT weekday, enabled, start_time_local, end_time_local
					FROM weekly_hours
					WHERE weekday = ?
					LIMIT 1
				`
			)
				.bind(weekday)
				.first();

			if (!hours || Number(hours.enabled) !== 1) {
				return Response.json([]);
			}

			const exceptions = await getAvailabilityExceptions(env, date);

			if (hasClosedAllDayException(exceptions)) {
				return Response.json([]);
			}

			const [startHour, startMinute] = parseTime(hours.start_time_local);
			const [endHour, endMinute] = parseTime(hours.end_time_local);
			const workingStartMinute = startHour * 60 + startMinute;
			const workingEndMinute = endHour * 60 + endMinute;
			const localDayStartUtc = zonedTimeToUtc(date, "00:00", TIMEZONE);
			const nextDate = addDays(date, 1);
			const localDayEndUtc = zonedTimeToUtc(nextDate, "00:00", TIMEZONE);

			const { results } = await env.DB.prepare(
				`
					SELECT starts_at_utc, ends_at_utc
					FROM bookings
					WHERE status != 'cancelled'
					  AND starts_at_utc < ?
					  AND ends_at_utc > ?
					ORDER BY starts_at_utc ASC
				`
			)
				.bind(localDayEndUtc.toISOString(), localDayStartUtc.toISOString())
				.all();

			const slots = [];
			const serviceMinutes = Number(service.duration_minutes);
			const lastStartMinute = workingEndMinute - serviceMinutes - settings.bufferMinutes;
			const now = new Date();
			const todayInHelsinkiParts = getLocalDateParts(now, TIMEZONE);
			const isToday =
				todayInHelsinkiParts.year === Number(date.slice(0, 4)) &&
				todayInHelsinkiParts.month === Number(date.slice(5, 7)) &&
				todayInHelsinkiParts.day === Number(date.slice(8, 10));
			const earliestSameDayStart = isToday
				? getEarliestSameDayStart(now, settings.sameDayNoticeMinutes, settings.slotIntervalMinutes)
				: null;

			if (lastStartMinute < workingStartMinute) {
				return Response.json([]);
			}

			for (
				let minuteOfDay = workingStartMinute;
				minuteOfDay <= lastStartMinute;
				minuteOfDay += settings.slotIntervalMinutes
			) {
				const candidateTime = formatMinuteOfDay(minuteOfDay);
				const candidateStart = zonedTimeToUtc(date, candidateTime, TIMEZONE);
				const candidateEnd = new Date(candidateStart.getTime() + serviceMinutes * 60_000);

				if (isToday && candidateStart.getTime() < earliestSameDayStart.getTime()) {
					continue;
				}

				if (hasExceptionConflict(exceptions, date, candidateStart, candidateEnd, settings.bufferMinutes)) {
					continue;
				}

				const hasConflict = hasBookingConflict(results ?? [], candidateStart, candidateEnd, settings.bufferMinutes);

				if (!hasConflict) {
					slots.push(candidateTime);
				}
			}

			return Response.json(slots);
		}

		if (url.pathname === "/api/bookings") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			let body;

			try {
				body = await request.json();
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			const serviceId = Number(body?.serviceId);
			const date = body?.date;
			const time = body?.time;
			const name = body?.name;
			const email = body?.email;
			const address = body?.address;
			const notes = normalizeOptionalText(body?.notes);
			const rescheduleToken =
				body?.rescheduleToken == null ? null : normalizeManageToken(body?.rescheduleToken);

			if (
				!Number.isInteger(serviceId) ||
				!isIsoDate(date) ||
				!isTimeString(time) ||
				!isNonEmptyString(name) ||
				!isNonEmptyString(email) ||
				!isNonEmptyString(address) ||
				(body?.rescheduleToken != null && body?.rescheduleToken !== "" && rescheduleToken == null)
			) {
				return json({ error: "Invalid booking payload" }, 400);
			}

			const created = await createBooking(env, {
				serviceId,
				date,
				time,
				name,
				email,
				address,
				notes,
				enforceWorkingHours: true
			});

			if (created.conflict) {
				return json({ error: "Requested slot is not available" }, 409);
			}

			if (created.error) {
				return json({ error: created.error }, 400);
			}

			try {
				await cancelRescheduledBooking(env, rescheduleToken, created.id);
			} catch (error) {
				console.error("Reschedule cleanup failed", error);
			}

			try {
				await sendBookingNotification(env, {
					serviceId,
					date,
					time,
					name,
					email,
					address,
					notes
				});
			} catch (error) {
				console.error("Booking notification failed", error);
			}

			try {
				await sendCustomerConfirmation(env, {
					baseUrl: url.origin,
					manageToken: created.manageToken,
					serviceId,
					date,
					time,
					name,
					email,
					address
				});
			} catch (error) {
				console.error("Customer confirmation failed", error);
			}

			return Response.json({ ok: true, id: created.id });
		}

		if (url.pathname === "/api/admin/bookings") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const now = new Date().toISOString();
			const { results } = await env.DB.prepare(
				`
					SELECT
						bookings.id,
						bookings.service_id,
						bookings.customer_name,
						bookings.customer_email,
						bookings.customer_address,
						bookings.notes,
						bookings.starts_at_utc,
						bookings.ends_at_utc,
						bookings.status,
						services.duration_minutes,
						services.price_cents
					FROM bookings
					INNER JOIN services ON services.id = bookings.service_id
					WHERE bookings.starts_at_utc >= ?
					  AND bookings.status = 'confirmed'
					ORDER BY bookings.starts_at_utc ASC
				`
			)
				.bind(now)
				.all();

			return Response.json(
				(results ?? []).map((booking) => ({
					id: booking.id,
					date: formatFinnishDate(booking.starts_at_utc),
					time: formatFinnishTime(booking.starts_at_utc),
					durationMinutes: Number(booking.duration_minutes),
					priceCents: Number(booking.price_cents),
					name: booking.customer_name,
					email: booking.customer_email,
					address: booking.customer_address,
					notes: booking.notes,
					status: booking.status
				}))
			);
		}

		if (url.pathname === "/api/admin/report") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const month = url.searchParams.get("month");

			if (!isMonthString(month)) {
				return json({ error: "Invalid month" }, 400);
			}

			return Response.json(await getMonthlyReport(env, month));
		}

		if (url.pathname === "/api/admin/report/pdf") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const month = url.searchParams.get("month");

			if (!isMonthString(month)) {
				return json({ error: "Invalid month" }, 400);
			}

			const report = await getMonthlyReport(env, month);
			const pdf = createMonthlyReportPdf(report);

			return new Response(pdf, {
				headers: {
					"content-type": "application/pdf",
					"content-disposition": `attachment; filename="fiksiribu-kuukausiraportti-${month}.pdf"`
				}
			});
		}

		if (url.pathname === "/api/admin/history") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const { results } = await env.DB.prepare(
				`
					SELECT
						bookings.id,
						bookings.service_id,
						bookings.customer_name,
						bookings.customer_email,
						bookings.customer_address,
						bookings.notes,
						bookings.starts_at_utc,
						bookings.ends_at_utc,
						bookings.status,
						services.duration_minutes,
						services.price_cents
					FROM bookings
					INNER JOIN services ON services.id = bookings.service_id
					WHERE bookings.status IN ('cancelled', 'completed')
					ORDER BY bookings.starts_at_utc DESC
				`
			).all();

			return Response.json(
				(results ?? []).map((booking) => ({
					id: booking.id,
					date: formatFinnishDate(booking.starts_at_utc),
					time: formatFinnishTime(booking.starts_at_utc),
					durationMinutes: Number(booking.duration_minutes),
					priceCents: Number(booking.price_cents),
					name: booking.customer_name,
					email: booking.customer_email,
					address: booking.customer_address,
					notes: booking.notes,
					status: booking.status
				}))
			);
		}

		if (url.pathname === "/api/admin/audit/unprocessed-past") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const now = new Date().toISOString();
			const { results } = await env.DB.prepare(
				`
					SELECT
						bookings.id,
						bookings.service_id,
						bookings.customer_name,
						bookings.customer_email,
						bookings.customer_address,
						bookings.notes,
						bookings.starts_at_utc,
						bookings.ends_at_utc,
						bookings.status,
						services.duration_minutes,
						services.price_cents
					FROM bookings
					INNER JOIN services ON services.id = bookings.service_id
					WHERE bookings.status = 'confirmed'
					  AND bookings.starts_at_utc < ?
					ORDER BY bookings.starts_at_utc DESC
				`
			)
				.bind(now)
				.all();

			return Response.json(
				(results ?? []).map((booking) => ({
					id: booking.id,
					date: formatFinnishDate(booking.starts_at_utc),
					time: formatFinnishTime(booking.starts_at_utc),
					durationMinutes: Number(booking.duration_minutes),
					priceCents: Number(booking.price_cents),
					name: booking.customer_name,
					email: booking.customer_email,
					address: booking.customer_address,
					notes: booking.notes,
					status: booking.status
				}))
			);
		}

		if (url.pathname === "/api/admin/bookings/manual") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			let body;

			try {
				body = await request.json();
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			const serviceId = Number(body?.serviceId);
			const date = body?.date;
			const time = body?.time;
			const name = body?.name;
			const email = body?.email;
			const address = body?.address;
			const notes = normalizeOptionalText(body?.notes);

			if (
				!Number.isInteger(serviceId) ||
				!isIsoDate(date) ||
				!isTimeString(time) ||
				!isNonEmptyString(name) ||
				!isNonEmptyString(email) ||
				!isNonEmptyString(address)
			) {
				return json({ error: "Invalid booking payload" }, 400);
			}

			const created = await createBooking(env, {
				serviceId,
				date,
				time,
				name,
				email,
				address,
				notes,
				enforceWorkingHours: false
			});

			if (created.conflict) {
				return json({ error: "Requested slot is not available" }, 409);
			}

			if (created.error) {
				return json({ error: created.error }, 400);
			}

			return Response.json({ ok: true, id: created.id });
		}

		if (url.pathname === "/api/admin/exceptions") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method === "GET") {
				const { results } = await env.DB.prepare(
					`
						SELECT id, date_local, type, start_time_local, end_time_local, created_at_utc
						FROM availability_exceptions
						ORDER BY date_local ASC, start_time_local ASC, created_at_utc ASC
					`
				).all();

				return Response.json(
					(results ?? []).map((row) => ({
						id: row.id,
						date: row.date_local,
						type: row.type,
						startTime: row.start_time_local ?? "",
						endTime: row.end_time_local ?? "",
						createdAtUtc: row.created_at_utc
					}))
				);
			}

			if (request.method === "POST") {
				let body;

				try {
					body = await request.json();
				} catch {
					return json({ error: "Invalid JSON body" }, 400);
				}

				const date = body?.date;
				const type = body?.type;
				const startTime = body?.startTime ?? "";
				const endTime = body?.endTime ?? "";

				if (!isIsoDate(date) || !isValidExceptionPayload(type, startTime, endTime)) {
					return json({ error: "Invalid exception payload" }, 400);
				}

				const exceptionId = crypto.randomUUID();

				await env.DB.prepare(
					`
						INSERT INTO availability_exceptions (
							id,
							date_local,
							type,
							start_time_local,
							end_time_local,
							created_at_utc
						)
						VALUES (?, ?, ?, ?, ?, ?)
					`
				)
					.bind(
						exceptionId,
						date,
						type,
						type === "blocked_range" ? startTime : null,
						type === "blocked_range" ? endTime : null,
						new Date().toISOString()
					)
					.run();

				return Response.json({ ok: true, id: exceptionId });
			}

			return json({ error: "Method not allowed" }, 405);
		}

		if (url.pathname === "/api/manage") {
			if (request.method !== "GET") {
				return json({ error: "Method not allowed" }, 405);
			}

			const token = url.searchParams.get("token");

			if (!isNonEmptyString(token)) {
				return json({ error: "Invalid token" }, 400);
			}

			const booking = await env.DB.prepare(
				`
					SELECT
						bookings.id,
						bookings.customer_name,
						bookings.customer_email,
						bookings.customer_address,
						bookings.notes,
						bookings.starts_at_utc,
						bookings.ends_at_utc,
						bookings.status,
						services.duration_minutes
					FROM bookings
					INNER JOIN services ON services.id = bookings.service_id
					WHERE bookings.manage_token = ?
					LIMIT 1
				`
			)
				.bind(token.trim())
				.first();

			if (!booking) {
				return json({ error: "Booking not found" }, 404);
			}

			return Response.json({
				id: booking.id,
				serviceId: Number(booking.service_id),
				date: formatFinnishDate(booking.starts_at_utc),
				time: formatFinnishTime(booking.starts_at_utc),
				durationMinutes: Number(booking.duration_minutes),
				name: booking.customer_name,
				email: booking.customer_email,
				address: booking.customer_address,
				notes: booking.notes,
				status: booking.status
			});
		}

		if (url.pathname === "/api/manage/cancel") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			let body;

			try {
				body = await request.json();
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			const token = body?.token;

			if (!isNonEmptyString(token)) {
				return json({ error: "Invalid token" }, 400);
			}

			const booking = await env.DB.prepare(
				`
					SELECT id, status
					FROM bookings
					WHERE manage_token = ?
					LIMIT 1
				`
			)
				.bind(token.trim())
				.first();

			if (!booking) {
				return json({ error: "Booking not found" }, 404);
			}

			if (booking.status === "cancelled") {
				return json({ error: "Booking already cancelled" }, 409);
			}

			await env.DB.prepare(
				`
					UPDATE bookings
					SET status = 'cancelled'
					WHERE id = ?
				`
			)
				.bind(booking.id)
				.run();

			return Response.json({ ok: true });
		}

		if (url.pathname === "/api/manage/reschedule") {
			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			return Response.json({
				ok: true,
				bookingUrl: "/"
			});
		}

		if (url.pathname.startsWith("/api/admin/exceptions/")) {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "DELETE") {
				return json({ error: "Method not allowed" }, 405);
			}

			const exceptionId = url.pathname.split("/").pop();

			if (!exceptionId) {
				return json({ error: "Invalid exception id" }, 400);
			}

			const result = await env.DB.prepare(
				`
					DELETE FROM availability_exceptions
					WHERE id = ?
				`
			)
				.bind(exceptionId)
				.run();

			if ((result.meta?.changes ?? 0) < 1) {
				return json({ error: "Exception not found" }, 404);
			}

			return Response.json({ ok: true });
		}

		if (url.pathname.startsWith("/api/admin/bookings/") && url.pathname.endsWith("/restore")) {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			const pathParts = url.pathname.split("/");
			const bookingId = pathParts[pathParts.length - 2];

			if (!bookingId) {
				return json({ error: "Invalid booking id" }, 400);
			}

			const booking = await env.DB.prepare(
				`
					SELECT id, status, starts_at_utc, ends_at_utc
					FROM bookings
					WHERE id = ?
					LIMIT 1
				`
			)
				.bind(bookingId)
				.first();

			if (!booking) {
				return json({ error: "Booking not found" }, 404);
			}

			const bookingStart = new Date(booking.starts_at_utc);

			if (bookingStart.getTime() <= Date.now()) {
				return json({ error: "Past booking cannot be restored" }, 409);
			}

			if (booking.status === "confirmed") {
				return json({ error: "Booking is already confirmed" }, 409);
			}

			if (!isRestorableBookingStatus(booking.status)) {
				return json({ error: "Booking status cannot be restored" }, 409);
			}

			const settings = await getBookingSettings(env);
			const bookingEnd = new Date(booking.ends_at_utc);
			const conflictWindowStart = new Date(bookingStart.getTime() - settings.bufferMinutes * 60_000);
			const conflictWindowEnd = new Date(bookingEnd.getTime() + settings.bufferMinutes * 60_000);
			const { results } = await env.DB.prepare(
				`
					SELECT id, starts_at_utc, ends_at_utc
					FROM bookings
					WHERE id != ?
					  AND status = 'confirmed'
					  AND starts_at_utc < ?
					  AND ends_at_utc > ?
					ORDER BY starts_at_utc ASC
				`
			)
				.bind(booking.id, conflictWindowEnd.toISOString(), conflictWindowStart.toISOString())
				.all();

			if (hasBookingConflict(results ?? [], bookingStart, bookingEnd, settings.bufferMinutes)) {
				return json({ error: "Booking time is no longer available" }, 409);
			}

			const result = await env.DB.prepare(
				`
					UPDATE bookings
					SET status = 'confirmed'
					WHERE id = ?
				`
			)
				.bind(booking.id)
				.run();

			if ((result.meta?.changes ?? 0) < 1) {
				return json({ error: "Booking not found" }, 404);
			}

			return Response.json({ ok: true });
		}

		if (url.pathname.startsWith("/api/admin/bookings/")) {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			const bookingId = url.pathname.split("/").pop();

			if (!bookingId) {
				return json({ error: "Invalid booking id" }, 400);
			}

			if (request.method === "DELETE") {
				const booking = await env.DB.prepare(
					`
						SELECT id, status
						FROM bookings
						WHERE id = ?
						LIMIT 1
					`
				)
					.bind(bookingId)
					.first();

				if (!booking) {
					return json({ error: "Booking not found" }, 404);
				}

				if (!isDeletableBookingStatus(booking.status)) {
					return json({ error: "Confirmed booking cannot be permanently deleted" }, 409);
				}

				const result = await env.DB.prepare(
					`
						DELETE FROM bookings
						WHERE id = ?
					`
				)
					.bind(bookingId)
					.run();

				if ((result.meta?.changes ?? 0) < 1) {
					return json({ error: "Booking not found" }, 404);
				}

				return Response.json({ ok: true });
			}

			if (request.method !== "PATCH") {
				return json({ error: "Method not allowed" }, 405);
			}

			let body;

			try {
				body = await request.json();
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			const status = body?.status;

			if (!isAdminBookingStatus(status)) {
				return json({ error: "Invalid status" }, 400);
			}

			const booking = await env.DB.prepare(
				`
					SELECT id, status
					FROM bookings
					WHERE id = ?
					LIMIT 1
				`
			)
				.bind(bookingId)
				.first();

			if (!booking) {
				return json({ error: "Booking not found" }, 404);
			}

			if (booking.status !== "confirmed") {
				return json({ error: "Booking status cannot be changed" }, 409);
			}

			const result = await env.DB.prepare(
				`
					UPDATE bookings
					SET status = ?
					WHERE id = ?
				`
			)
				.bind(status, bookingId)
				.run();

			if ((result.meta?.changes ?? 0) < 1) {
				return json({ error: "Booking not found" }, 404);
			}

			return Response.json({ ok: true });
		}

		if (url.pathname === "/api/admin/hours") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method === "GET") {
				const { results } = await env.DB.prepare(
					`
						SELECT weekday, enabled, start_time_local, end_time_local
						FROM weekly_hours
						ORDER BY weekday ASC
					`
				).all();

				return Response.json(
					(results ?? []).map((row) => ({
						weekday: Number(row.weekday),
						label: WEEKDAY_LABELS[Number(row.weekday)] ?? "",
						enabled: Number(row.enabled) === 1,
						startTime: row.start_time_local ?? "",
						endTime: row.end_time_local ?? ""
					}))
				);
			}

			if (request.method === "PUT") {
				let body;

				try {
					body = await request.json();
				} catch {
					return json({ error: "Invalid JSON body" }, 400);
				}

				if (!Array.isArray(body) || body.length !== 7) {
					return json({ error: "Invalid hours payload" }, 400);
				}

				for (const row of body) {
					if (!isValidWeeklyHoursRow(row)) {
						return json({ error: "Invalid hours payload" }, 400);
					}
				}

				await env.DB.batch(
					body.map((row) =>
						env.DB.prepare(
							`
								UPDATE weekly_hours
								SET enabled = ?, start_time_local = ?, end_time_local = ?
								WHERE weekday = ?
							`
						).bind(
							row.enabled ? 1 : 0,
							row.enabled ? row.startTime : null,
							row.enabled ? row.endTime : null,
							row.weekday
						)
					)
				);

				return Response.json({ ok: true });
			}

			return json({ error: "Method not allowed" }, 405);
		}

		if (url.pathname === "/api/admin/settings") {
			const unauthorized = requireAdmin(request, env);

			if (unauthorized) {
				return unauthorized;
			}

			if (request.method === "GET") {
				return Response.json(await getBookingSettings(env));
			}

			if (request.method === "PUT") {
				let body;

				try {
					body = await request.json();
				} catch {
					return json({ error: "Invalid JSON body" }, 400);
				}

				if (!isValidBookingSettingsPayload(body)) {
					return json({ error: "Invalid settings payload" }, 400);
				}

				await env.DB.prepare(
					`
						INSERT INTO booking_settings (
							id,
							same_day_notice_minutes,
							buffer_minutes,
							slot_interval_minutes,
							updated_at_utc
						)
						VALUES (1, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET
							same_day_notice_minutes = excluded.same_day_notice_minutes,
							buffer_minutes = excluded.buffer_minutes,
							slot_interval_minutes = excluded.slot_interval_minutes,
							updated_at_utc = excluded.updated_at_utc
					`
				)
					.bind(
						body.sameDayNoticeMinutes,
						body.bufferMinutes,
						body.slotIntervalMinutes,
						new Date().toISOString()
					)
					.run();

				return Response.json({ ok: true });
			}

			return json({ error: "Method not allowed" }, 405);
		}

		return env.ASSETS.fetch(request);
	}
};

const TIMEZONE = "Europe/Helsinki";
const DEFAULT_SLOT_INTERVAL_MINUTES = 15;
const DEFAULT_BUFFER_MINUTES = 45;
const DEFAULT_SAME_DAY_NOTICE_MINUTES = 120;
const ALLOWED_SLOT_INTERVAL_MINUTES = new Set([5, 10, 15, 20, 30, 45, 60]);
const WEEKDAY_LABELS = {
	1: "Maanantai",
	2: "Tiistai",
	3: "Keskiviikko",
	4: "Torstai",
	5: "Perjantai",
	6: "Lauantai",
	7: "Sunnuntai"
};

function requireAdmin(request, env) {
	if (request.headers.get("x-admin-key") !== env.ADMIN_KEY) {
		return json({ error: "Unauthorized" }, 401);
	}

	return null;
}

function json(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=UTF-8"
		}
	});
}

async function getMonthlyReport(env, month) {
	const monthStartUtc = zonedTimeToUtc(`${month}-01`, "00:00", TIMEZONE);
	const monthEndUtc = zonedTimeToUtc(addMonths(`${month}-01`, 1), "00:00", TIMEZONE);
	const { results } = await env.DB.prepare(
		`
			SELECT
				services.id AS service_id,
				services.duration_minutes,
				services.price_cents,
				SUM(CASE WHEN bookings.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
				SUM(CASE WHEN bookings.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
				SUM(CASE WHEN bookings.status = 'completed' THEN services.price_cents ELSE 0 END) AS revenue_cents
			FROM bookings
			INNER JOIN services ON services.id = bookings.service_id
			WHERE bookings.status IN ('confirmed', 'completed')
			  AND bookings.starts_at_utc >= ?
			  AND bookings.starts_at_utc < ?
			GROUP BY services.id, services.duration_minutes, services.price_cents
			ORDER BY services.duration_minutes ASC
		`
	)
		.bind(monthStartUtc.toISOString(), monthEndUtc.toISOString())
		.all();

	const byService = (results ?? []).map((row) => ({
		serviceId: Number(row.service_id),
		durationMinutes: Number(row.duration_minutes),
		priceCents: Number(row.price_cents),
		confirmedCount: Number(row.confirmed_count ?? 0),
		completedCount: Number(row.completed_count ?? 0),
		revenueCents: Number(row.revenue_cents ?? 0)
	}));
	const totals = byService.reduce(
		(accumulator, row) => ({
			confirmedBookings: accumulator.confirmedBookings + row.confirmedCount,
			completedBookings: accumulator.completedBookings + row.completedCount,
			revenueCents: accumulator.revenueCents + row.revenueCents
		}),
		{ confirmedBookings: 0, completedBookings: 0, revenueCents: 0 }
	);

	return {
		month,
		totals,
		byService
	};
}

function isIsoDate(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isMonthString(value) {
	return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

function isTimeString(value) {
	return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

function isAdminBookingStatus(value) {
	return value === "cancelled" || value === "completed";
}

function isDeletableBookingStatus(value) {
	return value === "cancelled" || value === "completed";
}

function isRestorableBookingStatus(value) {
	return value === "cancelled" || value === "completed";
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value) {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();

	return trimmed ? trimmed : null;
}

function normalizeManageToken(value) {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();

	return trimmed ? trimmed : null;
}

function isValidExceptionPayload(type, startTime, endTime) {
	if (type === "closed_all_day") {
		return true;
	}

	if (type !== "blocked_range" || !isTimeString(startTime) || !isTimeString(endTime)) {
		return false;
	}

	const [startHour, startMinute] = parseTime(startTime);
	const [endHour, endMinute] = parseTime(endTime);

	return startHour * 60 + startMinute < endHour * 60 + endMinute;
}

function isValidWeeklyHoursRow(row) {
	if (!row || !Number.isInteger(row.weekday) || row.weekday < 1 || row.weekday > 7 || typeof row.enabled !== "boolean") {
		return false;
	}

	if (!row.enabled) {
		return true;
	}

	if (!isTimeString(row.startTime) || !isTimeString(row.endTime)) {
		return false;
	}

	const [startHour, startMinute] = parseTime(row.startTime);
	const [endHour, endMinute] = parseTime(row.endTime);

	return startHour * 60 + startMinute < endHour * 60 + endMinute;
}

function isValidBookingSettingsPayload(value) {
	if (!value || typeof value !== "object") {
		return false;
	}

	if (
		!Number.isInteger(value.sameDayNoticeMinutes) ||
		value.sameDayNoticeMinutes < 0 ||
		value.sameDayNoticeMinutes > 1440
	) {
		return false;
	}

	if (!Number.isInteger(value.bufferMinutes) || value.bufferMinutes < 0 || value.bufferMinutes > 480) {
		return false;
	}

	if (!Number.isInteger(value.slotIntervalMinutes) || !ALLOWED_SLOT_INTERVAL_MINUTES.has(value.slotIntervalMinutes)) {
		return false;
	}

	return true;
}

function parseTime(value) {
	if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
		throw new Error("Invalid time value");
	}

	return value.split(":").map(Number);
}

function getWeekdayNumber(dateString) {
	const [year, month, day] = dateString.split("-").map(Number);
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

	return weekday === 0 ? 7 : weekday;
}

function addDays(dateString, daysToAdd) {
	const [year, month, day] = dateString.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + daysToAdd));

	return [
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0")
	].join("-");
}

function addMonths(dateString, monthsToAdd) {
	const [year, month, day] = dateString.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1 + monthsToAdd, day));

	return [
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0")
	].join("-");
}

function formatMinuteOfDay(minuteOfDay) {
	const hours = Math.floor(minuteOfDay / 60);
	const minutes = minuteOfDay % 60;

	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function zonedTimeToUtc(dateString, timeString, timeZone) {
	const [year, month, day] = dateString.split("-").map(Number);
	const [hour, minute] = parseTime(timeString);
	const utcDateTime = Date.UTC(year, month - 1, day, hour, minute, 0);
	let guess = utcDateTime;

	for (let i = 0; i < 4; i += 1) {
		const offsetMinutes = getTimeZoneOffsetMinutes(new Date(guess), timeZone);
		const nextGuess = utcDateTime - offsetMinutes * 60_000;

		if (nextGuess === guess) {
			break;
		}

		guess = nextGuess;
	}

	return new Date(guess);
}

function getTimeZoneOffsetMinutes(date, timeZone) {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	});
	const parts = formatter.formatToParts(date);
	const values = {};

	for (const part of parts) {
		if (part.type !== "literal") {
			values[part.type] = part.value;
		}
	}

	const asUtc = Date.UTC(
		Number(values.year),
		Number(values.month) - 1,
		Number(values.day),
		Number(values.hour),
		Number(values.minute),
		Number(values.second)
	);

	return (asUtc - date.getTime()) / 60_000;
}

function getLocalDateParts(date, timeZone) {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	});
	const parts = formatter.formatToParts(date);
	const values = {};

	for (const part of parts) {
		if (part.type !== "literal") {
			values[part.type] = Number(part.value);
		}
	}

	return {
		year: values.year,
		month: values.month,
		day: values.day
	};
}

function getCurrentLocalDateString(timeZone) {
	const { year, month, day } = getLocalDateParts(new Date(), timeZone);

	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function getBookingSettings(env) {
	const settings = await env.DB.prepare(
		`
			SELECT same_day_notice_minutes, buffer_minutes, slot_interval_minutes
			FROM booking_settings
			WHERE id = 1
			LIMIT 1
		`
	).first();

	const resolved = {
		sameDayNoticeMinutes: Number(settings?.same_day_notice_minutes ?? DEFAULT_SAME_DAY_NOTICE_MINUTES),
		bufferMinutes: Number(settings?.buffer_minutes ?? DEFAULT_BUFFER_MINUTES),
		slotIntervalMinutes: Number(settings?.slot_interval_minutes ?? DEFAULT_SLOT_INTERVAL_MINUTES)
	};

	if (!isValidBookingSettingsPayload(resolved)) {
		return {
			sameDayNoticeMinutes: DEFAULT_SAME_DAY_NOTICE_MINUTES,
			bufferMinutes: DEFAULT_BUFFER_MINUTES,
			slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES
		};
	}

	return resolved;
}

function isSameLocalDate(dateString, date, timeZone) {
	const local = getLocalDateParts(date, timeZone);

	return (
		local.year === Number(dateString.slice(0, 4)) &&
		local.month === Number(dateString.slice(5, 7)) &&
		local.day === Number(dateString.slice(8, 10))
	);
}

function getEarliestSameDayStart(now, sameDayNoticeMinutes, slotIntervalMinutes) {
	const minimumStart = new Date(now.getTime() + sameDayNoticeMinutes * 60_000);
	const slotMs = slotIntervalMinutes * 60_000;

	return new Date(Math.ceil(minimumStart.getTime() / slotMs) * slotMs);
}

function formatFinnishDate(isoString) {
	return new Intl.DateTimeFormat("fi-FI", {
		timeZone: TIMEZONE,
		day: "2-digit",
		month: "2-digit",
		year: "numeric"
	}).format(new Date(isoString));
}

function formatFinnishTime(isoString) {
	return new Intl.DateTimeFormat("fi-FI", {
		timeZone: TIMEZONE,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	}).format(new Date(isoString));
}

function formatFinnishMonthLabel(monthValue) {
	const [year, month] = monthValue.split("-").map(Number);

	return new Intl.DateTimeFormat("fi-FI", {
		month: "long",
		year: "numeric"
	}).format(new Date(year, month - 1, 1));
}

function formatPdfPrice(priceCents) {
	const euros = Number(priceCents) / 100;
	const formatted = new Intl.NumberFormat("fi-FI", {
		minimumFractionDigits: Number.isInteger(euros) ? 0 : 2,
		maximumFractionDigits: 2
	}).format(euros);

	return `${formatted} €`;
}

function createMonthlyReportPdf(report) {
	const lines = [
		{ text: "Fiksiribu", size: 20 },
		{ text: `Kuukausiraportti - ${formatFinnishMonthLabel(report.month)}`, size: 14 },
		{ text: "", size: 10 },
		{ text: "Yhteenveto", size: 13 },
		{ text: `Toteutuneet käynnit: ${report.totals.completedBookings}`, size: 11 },
		{ text: `Toteutunut liikevaihto: ${formatPdfPrice(report.totals.revenueCents)}`, size: 11 },
		{ text: `Tulevat vahvistetut varaukset: ${report.totals.confirmedBookings}`, size: 11 },
		{ text: "", size: 10 },
		{ text: "Palveluittain", size: 13 },
		...getPdfServiceRows(report)
	];

	return buildSimplePdf(lines);
}

function getPdfServiceRows(report) {
	const rowsByDuration = new Map(report.byService.map((row) => [row.durationMinutes, row]));

	return [60, 90, 120].map((durationMinutes) => {
		const row = rowsByDuration.get(durationMinutes);
		const completedCount = row?.completedCount ?? 0;
		const revenueCents = row?.revenueCents ?? 0;

		return {
			text: `${durationMinutes} min  ${completedCount} kpl  ${formatPdfPrice(revenueCents)}`,
			size: 11
		};
	});
}

function buildSimplePdf(lines) {
	const content = buildPdfContentStream(lines);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`
	];
	const chunks = ["%PDF-1.4\n"];
	const offsets = [0];

	for (const [index, object] of objects.entries()) {
		offsets.push(byteLength(chunks.join("")));
		chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
	}

	const xrefOffset = byteLength(chunks.join(""));
	chunks.push(`xref\n0 ${objects.length + 1}\n`);
	chunks.push("0000000000 65535 f \n");

	for (let i = 1; i < offsets.length; i += 1) {
		chunks.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
	}

	chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

	return latin1Bytes(chunks.join(""));
}

function buildPdfContentStream(lines) {
	const chunks = ["BT\n/F1 20 Tf\n50 790 Td\n"];
	let currentSize = 20;
	let isFirstTextLine = true;

	for (const line of lines) {
		if (line.text === "") {
			chunks.push("0 -18 Td\n");
			isFirstTextLine = false;
			continue;
		}

		if (line.size !== currentSize) {
			chunks.push(`/F1 ${line.size} Tf\n`);
			currentSize = line.size;
		}

		if (!isFirstTextLine) {
			chunks.push("0 -18 Td\n");
		}

		chunks.push("(");
		chunks.push(escapePdfText(line.text));
		chunks.push(") Tj\n");
		isFirstTextLine = false;
	}

	chunks.push("ET");
	return chunks.join("");
}

function escapePdfText(value) {
	return [...value]
		.map((character) => {
			const code = winAnsiCode(character);

			if (code === 40 || code === 41 || code === 92) {
				return `\\${String.fromCharCode(code)}`;
			}

			if (code < 32 || code > 126) {
				return `\\${code.toString(8).padStart(3, "0")}`;
			}

			return String.fromCharCode(code);
		})
		.join("");
}

function winAnsiCode(character) {
	const specialCodes = {
		"€": 0x80,
		"Ä": 0xc4,
		"Å": 0xc5,
		"Ö": 0xd6,
		"ä": 0xe4,
		"å": 0xe5,
		"ö": 0xf6
	};

	if (specialCodes[character] != null) {
		return specialCodes[character];
	}

	const code = character.charCodeAt(0);

	if (code >= 0 && code <= 255) {
		return code;
	}

	return 63;
}

function latin1Bytes(value) {
	const bytes = new Uint8Array(value.length);

	for (let i = 0; i < value.length; i += 1) {
		bytes[i] = value.charCodeAt(i) & 0xff;
	}

	return bytes;
}

function byteLength(value) {
	return value.length;
}

function formatFinnishDateFromIsoDate(dateString) {
	if (!isIsoDate(dateString)) {
		return dateString;
	}

	const [year, month, day] = dateString.split("-");
	return `${day}.${month}.${year}`;
}

function hasBookingConflict(bookings, candidateStart, candidateEnd, bufferMinutes) {
	const candidateStartMs = candidateStart.getTime();
	const candidateBlockedUntilMs = candidateEnd.getTime() + bufferMinutes * 60_000;

	return bookings.some((booking) => {
		const bookingStartMs = new Date(booking.starts_at_utc).getTime();
		const bookingBlockedUntilMs = new Date(booking.ends_at_utc).getTime() + bufferMinutes * 60_000;

		return candidateStartMs < bookingBlockedUntilMs && candidateBlockedUntilMs > bookingStartMs;
	});
}

async function getAvailabilityExceptions(env, date) {
	const { results } = await env.DB.prepare(
		`
			SELECT id, date_local, type, start_time_local, end_time_local
			FROM availability_exceptions
			WHERE date_local = ?
			ORDER BY start_time_local ASC, created_at_utc ASC
		`
	)
		.bind(date)
		.all();

	return results ?? [];
}

function hasClosedAllDayException(exceptions) {
	return exceptions.some((exception) => exception.type === "closed_all_day");
}

function hasExceptionConflict(exceptions, date, candidateStart, candidateEnd, bufferMinutes) {
	const candidateBlockedUntil = new Date(candidateEnd.getTime() + bufferMinutes * 60_000);

	for (const exception of exceptions) {
		if (exception.type === "closed_all_day") {
			return true;
		}

		if (exception.type !== "blocked_range") {
			continue;
		}

		const blockedStart = zonedTimeToUtc(date, exception.start_time_local, TIMEZONE);
		const blockedEnd = zonedTimeToUtc(date, exception.end_time_local, TIMEZONE);

		if (
			candidateStart.getTime() < blockedEnd.getTime() &&
			candidateBlockedUntil.getTime() > blockedStart.getTime()
		) {
			return true;
		}
	}

	return false;
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function sendBookingNotification(env, booking) {
	if (!env.RESEND_API_KEY) {
		console.error("RESEND_API_KEY is not configured");
		return;
	}

	const service = await env.DB.prepare(
		`
			SELECT duration_minutes
			FROM services
			WHERE id = ?
			LIMIT 1
		`
	)
		.bind(booking.serviceId)
		.first();

	const lines = [
		"Uusi varaus Fiksiribu",
		"",
		`Nimi: ${booking.name}`,
		`Sahkoposti: ${booking.email}`,
		`Osoite: ${booking.address}`,
		`Palvelu: ${service ? `${Number(service.duration_minutes)} min` : `ID ${booking.serviceId}`}`,
		`Paiva: ${booking.date}`,
		`Aika: ${booking.time}`,
		`Lisatiedot: ${booking.notes ?? "-"}`
	];

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.RESEND_API_KEY}`,
			"content-type": "application/json"
		},
		body: JSON.stringify({
			from: "riikka@fiksiribu.fi",
			to: ["rkallio88@gmail.com"],
			subject: "Uusi varaus Fiksiribu",
			text: lines.join("\n")
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Resend API error ${response.status}: ${errorText}`);
	}
}

async function sendCustomerConfirmation(env, booking) {
	if (!env.RESEND_API_KEY) {
		console.error("RESEND_API_KEY is not configured");
		return;
	}

	const service = await env.DB.prepare(
		`
			SELECT duration_minutes
			FROM services
			WHERE id = ?
			LIMIT 1
		`
	)
		.bind(booking.serviceId)
		.first();

	const serviceText = service ? `${Number(service.duration_minutes)} min` : `ID ${booking.serviceId}`;
	const manageUrl = `${booking.baseUrl}/manage.html?token=${encodeURIComponent(booking.manageToken)}`;
	const bookingDateTime = `${formatFinnishDateFromIsoDate(booking.date)} klo ${booking.time}`;
	const textLines = [
		`Hei ${booking.name},`,
		"",
		"Kiitos varauksestasi.",
		"",
		"Varaustietosi:",
		`Ajankohta: ${bookingDateTime}`,
		`Palvelu: ${serviceText}`,
		`Osoite: ${booking.address}`,
		"",
		"Valmistautuminen käyntiin",
		"",
		"Käyntiä varten suosittelen ottamaan esille itsellesi pyyhkeen sekä peiton.",
		"Niska-hartia-alueen käsittelyä varten hierojalle olisi hyvä varata jakkara tai muu vastaava penkki, jonka päällä voi istua.",
		"Huomioithan myös, että hierontapöytää varten olisi hyvä olla järjestettynä tilaa.",
		"",
		"Varausajan siirto onnistuu yllä olevasta painikkeesta. Jos sinulla on kysyttävää, voit vastata tähän viestiin tai ottaa yhteyttä:",
		"riikka@fiksiribu.fi",
		"WhatsApp: +358 41 365 7840",
		"",
		`Siirrä aikaa: ${manageUrl}`
	];
	const html = `
		<div style="background:#0b0b10;padding:32px 16px;font-family:Segoe UI,Arial,sans-serif;color:#17131c;">
			<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;">
				<div style="padding:32px;background:linear-gradient(135deg,#e10087 0%,#ff3ca7 100%);color:#ffffff;">
					<div style="font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;opacity:0.9;">Fiksiribu</div>
					<h1 style="margin:12px 0 6px;font-size:28px;line-height:1.05;">Varausvahvistus</h1>
					<div style="font-size:16px;opacity:0.95;">Koulutettu hieroja Riikka Kallio</div>
				</div>
				<div style="padding:28px 28px 32px;">
					<p style="margin:0 0 16px;">Hei ${escapeHtml(booking.name)},</p>
					<p style="margin:0 0 20px;">Kiitos varauksestasi. Alla varauksesi tiedot.</p>
					<div style="background:#f7f3f8;border:1px solid #eadfeb;border-radius:18px;padding:18px 20px;margin-bottom:22px;">
						<div style="margin:0 0 8px;"><strong>Ajankohta:</strong> ${escapeHtml(bookingDateTime)}</div>
						<div style="margin:0 0 8px;"><strong>Palvelu:</strong> ${escapeHtml(serviceText)}</div>
						<div style="margin:0;"><strong>Osoite:</strong> ${escapeHtml(booking.address)}</div>
					</div>
					<h2 style="margin:0 0 12px;font-size:18px;">Valmistautuminen käyntiin</h2>
					<p style="margin:0 0 10px;">Käyntiä varten suosittelen ottamaan esille itsellesi pyyhkeen sekä peiton.</p>
					<p style="margin:0 0 10px;">Niska-hartia-alueen käsittelyä varten hierojalle olisi hyvä varata jakkara tai muu vastaava penkki, jonka päällä voi istua.</p>
					<p style="margin:0 0 22px;">Huomioithan myös, että hierontapöytää varten olisi hyvä olla järjestettynä tilaa.</p>
					<div style="margin:0 0 24px;">
						<a href="${escapeHtml(manageUrl)}" style="display:inline-block;padding:14px 20px;border-radius:999px;background:#e10087;color:#ffffff;text-decoration:none;font-weight:700;">Siirrä aikaa</a>
					</div>
					<p style="margin:0;color:#665d72;">Varausajan siirto onnistuu yllä olevasta painikkeesta. Jos sinulla on kysyttävää, voit vastata tähän viestiin tai ottaa yhteyttä:<br>riikka@fiksiribu.fi<br>WhatsApp: +358 41 365 7840</p>
				</div>
			</div>
		</div>
	`.trim();

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.RESEND_API_KEY}`,
			"content-type": "application/json"
		},
		body: JSON.stringify({
			from: "riikka@fiksiribu.fi",
			to: [booking.email],
			reply_to: "riikka@fiksiribu.fi",
			subject: "Varausvahvistus  Koulutettu hieroja Riikka Kallio | Fiksiribu",
			text: textLines.join("\n"),
			html
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Resend API error ${response.status}: ${errorText}`);
	}
}

async function cancelRescheduledBooking(env, manageToken, newBookingId) {
	if (!manageToken) {
		return;
	}

	const previousBooking = await env.DB.prepare(
		`
			SELECT id, status
			FROM bookings
			WHERE manage_token = ?
			LIMIT 1
		`
	)
		.bind(manageToken)
		.first();

	if (!previousBooking) {
		return;
	}

	if (previousBooking.id === newBookingId || previousBooking.status === "cancelled") {
		return;
	}

	await env.DB.prepare(
		`
			UPDATE bookings
			SET status = 'cancelled'
			WHERE id = ?
		`
	)
		.bind(previousBooking.id)
		.run();
}

async function createBooking(env, payload) {
	const settings = await getBookingSettings(env);
	const service = await env.DB.prepare(
		`
			SELECT id, duration_minutes
			FROM services
			WHERE id = ? AND is_active = 1
			LIMIT 1
		`
	)
		.bind(payload.serviceId)
		.first();

	if (!service) {
		return { error: "Service not found" };
	}

	const weekday = getWeekdayNumber(payload.date);
	const hours = await env.DB.prepare(
		`
			SELECT weekday, enabled, start_time_local, end_time_local
			FROM weekly_hours
			WHERE weekday = ?
			LIMIT 1
		`
	)
		.bind(weekday)
		.first();

	if (payload.enforceWorkingHours !== false) {
		if (!hours || Number(hours.enabled) !== 1) {
			return { error: "Requested slot is not available", conflict: true };
		}

		const [startHour, startMinute] = parseTime(hours.start_time_local);
		const [endHour, endMinute] = parseTime(hours.end_time_local);
		const [candidateHour, candidateMinute] = parseTime(payload.time);
		const serviceMinutes = Number(service.duration_minutes);
		const workingStartMinute = startHour * 60 + startMinute;
		const workingEndMinute = endHour * 60 + endMinute;
		const candidateMinuteOfDay = candidateHour * 60 + candidateMinute;
		const candidateEndMinute = candidateMinuteOfDay + serviceMinutes;
		const candidateBlockedEndMinute = candidateEndMinute + settings.bufferMinutes;

		if (
			candidateMinuteOfDay < workingStartMinute ||
			candidateBlockedEndMinute > workingEndMinute ||
			(candidateMinuteOfDay - workingStartMinute) % settings.slotIntervalMinutes !== 0
		) {
			return { error: "Requested slot is not available", conflict: true };
		}
	}

	const serviceMinutes = Number(service.duration_minutes);
	const localDayStartUtc = zonedTimeToUtc(payload.date, "00:00", TIMEZONE);
	const nextDate = addDays(payload.date, 1);
	const localDayEndUtc = zonedTimeToUtc(nextDate, "00:00", TIMEZONE);
	const candidateStart = zonedTimeToUtc(payload.date, payload.time, TIMEZONE);
	const candidateEnd = new Date(candidateStart.getTime() + serviceMinutes * 60_000);
	const now = new Date();
	const todayInHelsinki = getCurrentLocalDateString(TIMEZONE);
	const exceptions = await getAvailabilityExceptions(env, payload.date);

	if (payload.date < todayInHelsinki) {
		return { error: "Requested slot is not available", conflict: true };
	}

	if (isSameLocalDate(payload.date, now, TIMEZONE)) {
		const earliestSameDayStart = getEarliestSameDayStart(
			now,
			settings.sameDayNoticeMinutes,
			settings.slotIntervalMinutes
		);

		if (candidateStart.getTime() < earliestSameDayStart.getTime()) {
			return { error: "Requested slot is not available", conflict: true };
		}
	}

	if (
		hasClosedAllDayException(exceptions) ||
		hasExceptionConflict(exceptions, payload.date, candidateStart, candidateEnd, settings.bufferMinutes)
	) {
		return { error: "Requested slot is not available", conflict: true };
	}

	const { results } = await env.DB.prepare(
		`
			SELECT starts_at_utc, ends_at_utc
			FROM bookings
			WHERE status != 'cancelled'
			  AND starts_at_utc < ?
			  AND ends_at_utc > ?
			ORDER BY starts_at_utc ASC
		`
	)
		.bind(localDayEndUtc.toISOString(), localDayStartUtc.toISOString())
		.all();

	const hasConflict = hasBookingConflict(results ?? [], candidateStart, candidateEnd, settings.bufferMinutes);

	if (hasConflict) {
		return { error: "Requested slot is not available", conflict: true };
	}

	const bookingId = crypto.randomUUID();
	const manageToken = crypto.randomUUID();
	const createdAtUtc = new Date().toISOString();

	await env.DB.prepare(
		`
			INSERT INTO bookings (
				id,
				service_id,
				customer_name,
				customer_email,
				customer_address,
				notes,
				manage_token,
				starts_at_utc,
				ends_at_utc,
				timezone,
				status,
				created_at_utc
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`
	)
		.bind(
			bookingId,
			payload.serviceId,
			payload.name.trim(),
			payload.email.trim(),
			payload.address.trim(),
			payload.notes ?? null,
			manageToken,
			candidateStart.toISOString(),
			candidateEnd.toISOString(),
			TIMEZONE,
			"confirmed",
			createdAtUtc
		)
		.run();

	return {
		id: bookingId,
		manageToken
	};
}

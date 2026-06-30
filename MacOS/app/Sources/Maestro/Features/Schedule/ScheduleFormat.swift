import SwiftUI

// Presentation + parsing helpers for schedules. Kept pure (no I/O) so they're trivially
// correct; the countdown/when formatters are ported 1:1 from the web ProjectDetail.tsx.

// MARK: - UI intent types

/// What the composer's schedule button hands back to its host.
enum ScheduleRequest {
    case once(fireAt: Double)        // ms timestamp
    case repeating(RepeatOpts)
}

/// Recurrence chosen in the SchedulePicker "Repeat" tab / the ScheduleSheet.
struct RepeatOpts {
    var everyMinutes: Int?           // interval mode (mutually exclusive with time/cadence)
    var time: String?                // "HH:MM" clock mode
    var cadence: String?             // "daily" | "weekdays" | "Mon, Wed, Fri" | …
    var catchUp: Bool = false
}

// MARK: - Day-of-week ↔ cadence

/// Mon-first weekday labels (matches the web Scheduler's DOW order; index 0 = Mon … 6 = Sun).
let scheduleDOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/// Parse a saved cadence string back into selected weekday indices.
func daysFromCadence(_ cadence: String?) -> [Int] {
    let c = (cadence ?? "").lowercased()
    if c.contains("weekday") { return [0, 1, 2, 3, 4] }
    if c.contains("weekend") { return [5, 6] }
    if c.contains("daily") || c.contains("every day") { return [0, 1, 2, 3, 4, 5, 6] }
    var out: [Int] = []
    for (i, d) in scheduleDOW.enumerated() where c.contains(d.lowercased()) { out.append(i) }
    return out
}

/// Build a cadence string from selected weekday indices.
func cadenceFromDays(_ days: [Int]) -> String {
    let s = days.sorted()
    if s == [0, 1, 2, 3, 4] { return "weekdays" }
    if s == [5, 6] { return "weekend" }
    if s == [0, 1, 2, 3, 4, 5, 6] { return "daily" }
    return s.map { scheduleDOW[$0] }.joined(separator: ", ")
}

// MARK: - Time formatting

private func pad2(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

/// "2d 3h 12m" / "1h 04m 09s" / "9m 05s" / "45s" / "now".
func fmtCountdown(_ ms: Double) -> String {
    if ms <= 0 { return "now" }
    let total = Int(ms / 1000)
    let d = total / 86400, h = (total % 86400) / 3600, m = (total % 3600) / 60, s = total % 60
    if d > 0 { return "\(d)d \(h)h \(m)m" }
    if h > 0 { return "\(h)h \(pad2(m))m \(pad2(s))s" }
    if m > 0 { return "\(m)m \(pad2(s))s" }
    return "\(s)s"
}

/// "09:00" from a Date's clock components.
func hhmm(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

/// A Date today at the given "HH:MM" (defaults to 09:00 on parse failure).
func timeFromHHMM(_ s: String?) -> Date {
    let parts = (s ?? "09:00").split(separator: ":")
    let h = parts.count == 2 ? (Int(parts[0]) ?? 9) : 9
    let m = parts.count == 2 ? (Int(parts[1]) ?? 0) : 0
    return Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) ?? Date()
}

/// "Today 3:00 PM" / "Tomorrow 9:00 AM" / "Fri Jun 19, 9:00 AM".
func fmtWhen(_ tsMs: Double) -> String {
    let d = Date(timeIntervalSince1970: tsMs / 1000)
    let cal = Calendar.current
    let time = d.formatted(.dateTime.hour(.defaultDigits(amPM: .abbreviated)).minute(.twoDigits))
    if cal.isDateInToday(d) { return "Today \(time)" }
    if cal.isDateInTomorrow(d) { return "Tomorrow \(time)" }
    let date = d.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    return "\(date), \(time)"
}

/// The web "next run" relative string from a next-fire ms timestamp: "—" / "due now" / "5m" / "2h 3m".
func nextLine(_ nextRun: Double?) -> String {
    guard let nextRun else { return "—" }
    let ms = nextRun - Date().timeIntervalSince1970 * 1000
    if ms <= 0 { return "due now" }
    let mins = Int((ms / 60000).rounded())
    if mins < 60 { return "\(mins)m" }
    let hrs = mins / 60
    if hrs < 24 { return "\(hrs)h \(mins % 60)m" }
    let days = hrs / 24
    return "\(days)d \(hrs % 24)h"
}

/// The concrete fire time of `schedule` on `day`, or nil if it doesn't occur then. Interval
/// schedules return nil (no single time-of-day — they live in the list, not the clock grid).
func scheduleOccurrence(_ s: Schedule, on day: Date, cal: Calendar = .current) -> Date? {
    if s.isOneShot, let f = s.fireAt {
        let d = Date(timeIntervalSince1970: f / 1000)
        return cal.isDate(d, inSameDayAs: day) ? d : nil
    }
    if s.isInterval { return nil }
    guard s.hasClock, let t = s.time else { return nil }
    let cadence = s.cadence?.lowercased() ?? ""
    let days = daysFromCadence(s.cadence)
    let isDaily = cadence.contains("daily") || days.count == 7 || (days.isEmpty && cadence.isEmpty)
    let wd = (cal.component(.weekday, from: day) + 5) % 7   // 0=Mon … 6=Sun
    if !isDaily && !days.contains(wd) { return nil }
    let parts = t.split(separator: ":")
    guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
    return cal.date(bySettingHour: h, minute: m, second: 0, of: day)
}

// MARK: - Schedule-derived presentation

extension Schedule {
    var isInterval: Bool { (everyMinutes ?? 0) > 0 }
    var hasClock: Bool { !(time?.isEmpty ?? true) }
    var isOneShot: Bool { fireAt != nil && !isInterval && !hasClock }
    var isRecurring: Bool { isInterval || hasClock }

    /// Best next absolute fire time (ms) — for sorting, countdown, and calendar placement.
    var nextFireAt: Double? { fireAt ?? nextRun }

    /// Kinds the brain creates on its own. We render these read-only (delete-only).
    var isSystemKind: Bool {
        guard let k = kind else { return false }
        return ["auto-continue", "auto-answer", "keep-going", "retry-run", "whatsapp-analyze"].contains(k)
    }
    var isEditable: Bool { !isSystemKind }

    /// True for the per-chat one-shot user message that the inline composer queue shows.
    var isQueuedMessage: Bool { isOneShot && (kind == nil || kind == "message") }

    var kindTint: Color {
        switch kind {
        case "auto-continue", "keep-going": return Tok.purple
        case "auto-answer", "retry-run":    return Tok.orange
        case "whatsapp-analyze":            return Tok.green
        default:                            return Tok.blue   // message / nil / recurring task
        }
    }

    /// Short uppercase badge for system kinds (nil for user schedules).
    var kindBadge: String? {
        switch kind {
        case "auto-continue":   return "AUTO-CONTINUE"
        case "keep-going":      return "KEEP-GOING"
        case "auto-answer":     return "AUTO-ANSWER"
        case "retry-run":       return "RETRY"
        case "whatsapp-analyze":return "WHATSAPP"
        default:                return nil
        }
    }

    /// The web "cron line": "Every 1h · catch-up" / "once at 00:01" / "Every day at 09:00" / "On demand".
    var cronLine: String {
        if isInterval, let m = everyMinutes {
            let h = m / 60, mm = m % 60
            let base = "Every \(h > 0 ? "\(h)h" : "")\(mm > 0 ? " \(mm)m" : "")".trimmingCharacters(in: .whitespaces)
            return base + (catchUp == true ? " · catch-up" : "")
        }
        let cad = (cadence ?? "").trimmingCharacters(in: .whitespaces)
        let t = (time ?? "").trimmingCharacters(in: .whitespaces)
        if cad.isEmpty && t.isEmpty { return "On demand" }
        if t.isEmpty { return cad }
        let everyDay = cad.isEmpty || cad.lowercased().contains("every day") || cad == "*" || cad.lowercased() == "daily"
        let base = everyDay ? "Every day at \(t)" : "\(cad) at \(t)"
        return base + (catchUp == true ? " · catch-up" : "")
    }

    /// The web "system badge" for autopilot followups: keep-going → Autopilot; auto-answer → Auto-answer.
    var systemBadge: (label: String, icon: String)? {
        switch kind {
        case "keep-going": return ("Autopilot", "bolt")
        case "auto-answer": return ("Auto-answer", "bolt")
        default: return nil
        }
    }

    /// "Once" / "Every day at 09:00" / "Weekdays at 14:30" / "Mon, Wed, Fri at 09:00" / "Every 3 hours".
    var recurrenceLabel: String {
        if isInterval, let m = everyMinutes {
            if m % 60 == 0 { let h = m / 60; return "Every \(h) hour\(h == 1 ? "" : "s")" }
            return "Every \(m) min"
        }
        if hasClock, let t = time {
            let cad = cadence?.lowercased() ?? ""
            let days = daysFromCadence(cadence)
            let dayLabel: String
            if cad.contains("daily") || days.count == 7 { dayLabel = "Every day" }
            else if cad.contains("weekday") || days == [0, 1, 2, 3, 4] { dayLabel = "Weekdays" }
            else if cad.contains("weekend") || days == [5, 6] { dayLabel = "Weekend" }
            else if days.isEmpty { dayLabel = "Daily" }
            else { dayLabel = days.map { scheduleDOW[$0] }.joined(separator: ", ") }
            return "\(dayLabel) at \(t)"
        }
        return "Once"
    }
}

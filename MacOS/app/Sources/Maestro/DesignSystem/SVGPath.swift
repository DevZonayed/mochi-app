import SwiftUI
import CoreGraphics

/// A compact SVG path-data (`d` attribute) parser → SwiftUI `Shape`, so brand glyphs authored as
/// SVG (provider marks, etc.) render pixel-faithfully — including elliptical arcs (`A`/`a`). The
/// path is parsed once and scaled to fit the view's frame from the source `viewBox` (uniform
/// aspect, centered). Supports M m L l H h V v C c S s Q q T t A a Z z.
struct SVGShape: Shape {
    let pathData: String
    /// Source coordinate space (the SVG `viewBox` width/height).
    var viewBox: CGSize
    var fillRule: FillStyle = FillStyle(eoFill: true)

    func path(in rect: CGRect) -> Path {
        let raw = SVGPathParser.parse(pathData)
        // Uniform scale to fit, centered.
        let sx = rect.width / viewBox.width
        let sy = rect.height / viewBox.height
        let s = min(sx, sy)
        let tx = rect.minX + (rect.width - viewBox.width * s) / 2
        let ty = rect.minY + (rect.height - viewBox.height * s) / 2
        var t = CGAffineTransform(translationX: tx, y: ty).scaledBy(x: s, y: s)
        return Path(raw.cgPath.copy(using: &t) ?? raw.cgPath)
    }
}

enum SVGPathParser {
    /// Parse an SVG path `d` string into a `Path` in the source viewBox coordinate space.
    static func parse(_ d: String) -> Path {
        var path = Path()
        var i = d.startIndex
        var cmd: Character = " "
        var cur = CGPoint.zero        // current point
        var start = CGPoint.zero      // subpath start (for Z)
        var ctrl = CGPoint.zero       // last cubic/quad control reflection point
        var prevCmd: Character = " "

        func skipSep() {
            while i < d.endIndex, d[i] == " " || d[i] == "," || d[i] == "\n" || d[i] == "\t" || d[i] == "\r" { i = d.index(after: i) }
        }
        func readNum() -> CGFloat? {
            skipSep()
            var s = ""
            var seenDot = false, seenE = false
            // optional leading sign
            if i < d.endIndex, d[i] == "+" || d[i] == "-" { s.append(d[i]); i = d.index(after: i) }
            while i < d.endIndex {
                let c = d[i]
                if c.isNumber { s.append(c); i = d.index(after: i) }
                else if c == "." && !seenDot && !seenE { seenDot = true; s.append(c); i = d.index(after: i) }
                else if (c == "e" || c == "E") && !seenE { seenE = true; s.append(c); i = d.index(after: i)
                    if i < d.endIndex, d[i] == "+" || d[i] == "-" { s.append(d[i]); i = d.index(after: i) } }
                else { break }
            }
            return Double(s).map { CGFloat($0) }
        }
        func readFlag() -> CGFloat? {            // arc large/sweep flags are single digits, no separator needed
            skipSep()
            guard i < d.endIndex else { return nil }
            let c = d[i]
            if c == "0" || c == "1" { i = d.index(after: i); return c == "1" ? 1 : 0 }
            return readNum()
        }
        let cmdSet = Set("MmLlHhVvCcSsQqTtAaZz")

        while i < d.endIndex {
            skipSep()
            guard i < d.endIndex else { break }
            if cmdSet.contains(d[i]) { cmd = d[i]; i = d.index(after: i) }
            // else: implicit repeat of previous command (after M, repeats become L)
            let rel = cmd.isLowercase
            switch Character(cmd.uppercased()) {
            case "M":
                guard let x = readNum(), let y = readNum() else { break }
                cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.move(to: cur); start = cur
                cmd = rel ? "l" : "L"   // subsequent coords are implicit lineto
            case "L":
                guard let x = readNum(), let y = readNum() else { break }
                cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.addLine(to: cur)
            case "H":
                guard let x = readNum() else { break }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur)
            case "V":
                guard let y = readNum() else { break }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur)
            case "C":
                guard let x1 = readNum(), let y1 = readNum(), let x2 = readNum(), let y2 = readNum(), let x = readNum(), let y = readNum() else { break }
                let c1 = rel ? CGPoint(x: cur.x + x1, y: cur.y + y1) : CGPoint(x: x1, y: y1)
                let c2 = rel ? CGPoint(x: cur.x + x2, y: cur.y + y2) : CGPoint(x: x2, y: y2)
                let end = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.addCurve(to: end, control1: c1, control2: c2); ctrl = c2; cur = end
            case "S":
                guard let x2 = readNum(), let y2 = readNum(), let x = readNum(), let y = readNum() else { break }
                let c2 = rel ? CGPoint(x: cur.x + x2, y: cur.y + y2) : CGPoint(x: x2, y: y2)
                let end = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                let c1 = "CcSs".contains(prevCmd) ? CGPoint(x: 2 * cur.x - ctrl.x, y: 2 * cur.y - ctrl.y) : cur
                path.addCurve(to: end, control1: c1, control2: c2); ctrl = c2; cur = end
            case "Q":
                guard let x1 = readNum(), let y1 = readNum(), let x = readNum(), let y = readNum() else { break }
                let c1 = rel ? CGPoint(x: cur.x + x1, y: cur.y + y1) : CGPoint(x: x1, y: y1)
                let end = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                path.addQuadCurve(to: end, control: c1); ctrl = c1; cur = end
            case "T":
                guard let x = readNum(), let y = readNum() else { break }
                let end = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                let c1 = "QqTt".contains(prevCmd) ? CGPoint(x: 2 * cur.x - ctrl.x, y: 2 * cur.y - ctrl.y) : cur
                path.addQuadCurve(to: end, control: c1); ctrl = c1; cur = end
            case "A":
                guard let rx = readNum(), let ry = readNum(), let rot = readNum(),
                      let large = readFlag(), let sweep = readFlag(), let x = readNum(), let y = readNum() else { break }
                let end = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
                addArc(&path, from: cur, to: end, rx: rx, ry: ry, rotDeg: rot, large: large != 0, sweep: sweep != 0)
                cur = end
            case "Z":
                path.closeSubpath(); cur = start
            default: break
            }
            prevCmd = cmd
        }
        return path
    }

    /// Endpoint-parameterized elliptical arc → center parameterization (per the SVG spec), appended
    /// as a series of cubic bézier segments.
    private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotDeg: CGFloat, large: Bool, sweep: Bool) {
        if rxIn == 0 || ryIn == 0 { path.addLine(to: p1); return }
        var rx = abs(rxIn), ry = abs(ryIn)
        let phi = rotDeg * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosP * dx + sinP * dy
        let y1p = -sinP * dx + cosP * dy
        // Correct out-of-range radii
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 { let s = sqrt(lambda); rx *= s; ry *= s }
        let sign: CGFloat = (large != sweep) ? 1 : -1
        let num = max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p)
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let coef = sign * sqrt(den == 0 ? 0 : num / den)
        let cxp = coef * (rx * y1p / ry)
        let cyp = coef * -(ry * x1p / rx)
        let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            var a = acos(max(-1, min(1, len == 0 ? 1 : dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
        if sweep && dTheta < 0 { dTheta += 2 * .pi }
        let segments = Int(ceil(abs(dTheta) / (.pi / 2)))
        let delta = dTheta / CGFloat(max(1, segments))
        let t = (4.0 / 3.0) * tan(delta / 4)
        var ang = theta1
        for _ in 0..<max(1, segments) {
            let cos1 = cos(ang), sin1 = sin(ang)
            let ang2 = ang + delta
            let cos2 = cos(ang2), sin2 = sin(ang2)
            let e1 = point(cx, cy, rx, ry, cosP, sinP, cos1, sin1)
            let e2 = point(cx, cy, rx, ry, cosP, sinP, cos2, sin2)
            let d1 = deriv(rx, ry, cosP, sinP, cos1, sin1)
            let d2 = deriv(rx, ry, cosP, sinP, cos2, sin2)
            let c1 = CGPoint(x: e1.x + t * d1.x, y: e1.y + t * d1.y)
            let c2 = CGPoint(x: e2.x - t * d2.x, y: e2.y - t * d2.y)
            path.addCurve(to: e2, control1: c1, control2: c2)
            ang = ang2
        }
    }

    private static func point(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, _ cosP: CGFloat, _ sinP: CGFloat, _ cosT: CGFloat, _ sinT: CGFloat) -> CGPoint {
        let x = rx * cosT, y = ry * sinT
        return CGPoint(x: cx + cosP * x - sinP * y, y: cy + sinP * x + cosP * y)
    }
    private static func deriv(_ rx: CGFloat, _ ry: CGFloat, _ cosP: CGFloat, _ sinP: CGFloat, _ cosT: CGFloat, _ sinT: CGFloat) -> CGPoint {
        let x = -rx * sinT, y = ry * cosT
        return CGPoint(x: cosP * x - sinP * y, y: sinP * x + cosP * y)
    }
}

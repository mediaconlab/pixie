import AppKit
import SwiftUI

/// The soft blob body: a rounded "gumdrop" that is slightly wider at the bottom.
struct BlobShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let w = r.width, h = r.height, x = r.minX, y = r.minY
        p.move(to: CGPoint(x: x + w * 0.5, y: y))
        p.addCurve(to: CGPoint(x: x + w, y: y + h * 0.62),
                   control1: CGPoint(x: x + w * 0.86, y: y),
                   control2: CGPoint(x: x + w, y: y + h * 0.28))
        p.addCurve(to: CGPoint(x: x + w * 0.5, y: y + h),
                   control1: CGPoint(x: x + w, y: y + h * 0.92),
                   control2: CGPoint(x: x + w * 0.8, y: y + h))
        p.addCurve(to: CGPoint(x: x, y: y + h * 0.62),
                   control1: CGPoint(x: x + w * 0.2, y: y + h),
                   control2: CGPoint(x: x, y: y + h * 0.92))
        p.addCurve(to: CGPoint(x: x + w * 0.5, y: y),
                   control1: CGPoint(x: x, y: y + h * 0.28),
                   control2: CGPoint(x: x + w * 0.14, y: y))
        p.closeSubpath()
        return p
    }
}

/// A happy closed eye "^" arc (stroke it).
struct SmileEyeShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY), control: CGPoint(x: r.midX, y: r.minY - r.height * 0.6))
        return p
    }
}

/// Sleeping closed eye "‿" arc (stroke it).
struct ClosedEyeShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.midY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.midY), control: CGPoint(x: r.midX, y: r.maxY + r.height * 0.4))
        return p
    }
}

struct HeartShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let w = r.width, h = r.height, x = r.minX, y = r.minY
        p.move(to: CGPoint(x: x + w * 0.5, y: y + h))
        p.addCurve(to: CGPoint(x: x, y: y + h * 0.3),
                   control1: CGPoint(x: x + w * 0.2, y: y + h * 0.78),
                   control2: CGPoint(x: x, y: y + h * 0.55))
        p.addArc(center: CGPoint(x: x + w * 0.25, y: y + h * 0.28), radius: w * 0.25,
                 startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        p.addArc(center: CGPoint(x: x + w * 0.75, y: y + h * 0.28), radius: w * 0.25,
                 startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        p.addCurve(to: CGPoint(x: x + w * 0.5, y: y + h),
                   control1: CGPoint(x: x + w, y: y + h * 0.55),
                   control2: CGPoint(x: x + w * 0.8, y: y + h * 0.78))
        p.closeSubpath()
        return p
    }
}

/// Mouth line. `curve` −1 (frown) … 1 (smile). Drawn inside its rect, corners on the vertical middle.
struct MouthLineShape: Shape {
    var curve: Double

    var animatableData: Double {
        get { curve }
        set { curve = newValue }
    }

    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.midY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.midY),
                       control: CGPoint(x: r.midX, y: r.midY + CGFloat(curve) * r.height))
        return p
    }
}

/// Filled open mouth: top edge follows the smile curve, bottom edge drops by `open`.
struct MouthOpenShape: Shape {
    var curve: Double
    var open: Double

    func path(in r: CGRect) -> Path {
        var p = Path()
        let topControlY = r.midY + CGFloat(curve) * r.height * 0.5
        let bottomControlY = topControlY + CGFloat(open) * r.height * 1.6 + r.height * 0.15
        p.move(to: CGPoint(x: r.minX, y: r.midY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.midY), control: CGPoint(x: r.midX, y: topControlY))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.midY), control: CGPoint(x: r.midX, y: bottomControlY))
        p.closeSubpath()
        return p
    }
}

/// Speech-bubble tail (a small downward triangle with a soft tip).
struct BubbleTail: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.midX, y: r.maxY), control: CGPoint(x: r.midX + r.width * 0.15, y: r.midY))
        p.closeSubpath()
        return p
    }
}

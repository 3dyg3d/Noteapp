package expo.modules.geodesicink

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Turns a rough hand-drawn shape into a clean one: line, circle, ellipse,
 * triangle, rectangle or other four-sided shape. Pure geometry on world
 * coordinates (no Android types), so it can be tested off-device.
 *
 * The result is a polyline (closed shapes repeat their first point), sampled
 * densely enough that the normal stroke renderer draws it smoothly, with
 * corners left as single sharp vertices.
 */
object ShapeRecognizer {

  class Shape(val kind: String, val xs: FloatArray, val ys: FloatArray)

  private const val STEP = 1.5f // world units between output samples

  fun recognize(xsIn: FloatArray, ysIn: FloatArray): Shape? {
    val n = xsIn.size
    if (n < 8) return null
    var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
    var length = 0f
    for (i in 0 until n) {
      minX = min(minX, xsIn[i]); maxX = max(maxX, xsIn[i])
      minY = min(minY, ysIn[i]); maxY = max(maxY, ysIn[i])
      if (i > 0) length += hypot(xsIn[i] - xsIn[i - 1], ysIn[i] - ysIn[i - 1])
    }
    val diag = hypot(maxX - minX, maxY - minY)
    // Small enough to be a letter ("o", "l"): never snap, even if you pause.
    if (diag < 22f) return null

    val gap = hypot(xsIn[n - 1] - xsIn[0], ysIn[n - 1] - ysIn[0])
    val closed = gap < max(0.22f * diag, 0.12f * length)

    if (!closed) return line(xsIn, ysIn)

    val ellipse = fitEllipse(xsIn, ysIn)
    val poly = fitPolygon(xsIn, ysIn, diag)
    // Prefer whichever fits better; each must also fit well in absolute terms.
    val ellipseOk = ellipse != null && ellipse.second < 0.09f
    val polyOk = poly != null && poly.second < 0.035f
    return when {
      polyOk && (!ellipseOk || poly!!.second * 2.2f < ellipse!!.second) -> poly!!.first
      ellipseOk -> ellipse!!.first
      polyOk -> poly!!.first
      else -> null
    }
  }

  // ------------------------------------------------------------------ line

  private fun line(xs: FloatArray, ys: FloatArray): Shape? {
    val n = xs.size
    val ax = xs[0]; val ay = ys[0]; val bx = xs[n - 1]; val by = ys[n - 1]
    val len = hypot(bx - ax, by - ay)
    if (len < 22f) return null
    var maxDev = 0f
    for (i in 0 until n) {
      val d = abs((bx - ax) * (ay - ys[i]) - (ax - xs[i]) * (by - ay)) / len
      maxDev = max(maxDev, d)
    }
    if (maxDev / len > 0.06f) return null
    // Snap to horizontal / vertical / 45° when within 4°.
    var ang = atan2((by - ay).toDouble(), (bx - ax).toDouble())
    val step = PI / 4
    val nearest = Math.round(ang / step) * step
    if (abs(ang - nearest) < Math.toRadians(4.0)) ang = nearest
    val ex = ax + (len * cos(ang)).toFloat()
    val ey = ay + (len * sin(ang)).toFloat()
    return polyline("line", floatArrayOf(ax, ex), floatArrayOf(ay, ey), false)
  }

  // --------------------------------------------------------------- ellipse

  /** Principal-axis fit; returns the shape and its mean normalised radial error. */
  private fun fitEllipse(xs: FloatArray, ys: FloatArray): Pair<Shape, Float>? {
    val n = xs.size
    var cx = 0.0; var cy = 0.0
    for (i in 0 until n) { cx += xs[i]; cy += ys[i] }
    cx /= n; cy /= n
    var sxx = 0.0; var syy = 0.0; var sxy = 0.0
    for (i in 0 until n) {
      val dx = xs[i] - cx; val dy = ys[i] - cy
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy
    }
    sxx /= n; syy /= n; sxy /= n
    val theta = 0.5 * atan2(2 * sxy, sxx - syy)
    val c = cos(theta); val s = sin(theta)
    // Extent along each axis from the points themselves (robust to uneven sampling).
    var ra = 0.0; var rb = 0.0
    val us = DoubleArray(n); val vs = DoubleArray(n)
    for (i in 0 until n) {
      val dx = xs[i] - cx; val dy = ys[i] - cy
      us[i] = dx * c + dy * s
      vs[i] = -dx * s + dy * c
      ra = max(ra, abs(us[i])); rb = max(rb, abs(vs[i]))
    }
    // Max overshoots a hand-drawn loop slightly; pull in a touch.
    ra *= 0.97; rb *= 0.97
    if (ra < 3 || rb < 3) return null
    var err = 0.0
    for (i in 0 until n) {
      val r = sqrt((us[i] / ra) * (us[i] / ra) + (vs[i] / rb) * (vs[i] / rb))
      err += abs(r - 1)
    }
    err /= n
    var a = ra; var b = rb
    var kind = "ellipse"
    if (min(a, b) / max(a, b) > 0.86) {
      val r = (a + b) / 2; a = r; b = r; kind = "circle"
    }
    // Sample the outline.
    val circ = PI * (3 * (a + b) - sqrt((3 * a + b) * (a + 3 * b)))
    val m = max(24, (circ / STEP).toInt())
    // Start where the user started, going the way they went.
    val start = atan2(vs[0] / b, us[0] / a)
    val dir = if (signedArea(xs, ys) * (if (kind == "circle") 1.0 else 1.0) >= 0) 1.0 else -1.0
    val ox = FloatArray(m + 1); val oy = FloatArray(m + 1)
    for (k in 0..m) {
      val t = start + dir * 2 * PI * k / m
      val u = a * cos(t); val v = b * sin(t)
      ox[k] = (cx + u * c - v * s).toFloat()
      oy[k] = (cy + u * s + v * c).toFloat()
    }
    return Pair(Shape(kind, ox, oy), err.toFloat())
  }

  private fun signedArea(xs: FloatArray, ys: FloatArray): Double {
    var a = 0.0
    for (i in xs.indices) {
      val j = (i + 1) % xs.size
      a += (xs[i] * ys[j] - xs[j] * ys[i]).toDouble()
    }
    return a
  }

  // --------------------------------------------------------------- polygon

  /** Corner-finding fit; returns the shape and mean distance to it / diagonal. */
  private fun fitPolygon(xs: FloatArray, ys: FloatArray, diag: Float): Pair<Shape, Float>? {
    val n = xs.size
    // Douglas-Peucker on the closed path, split at the point farthest from the start.
    var far = 0; var farD = 0f
    for (i in 0 until n) {
      val d = hypot(xs[i] - xs[0], ys[i] - ys[0])
      if (d > farD) { farD = d; far = i }
    }
    val tol = 0.06f * diag
    val keep = BooleanArray(n)
    keep[0] = true; keep[far] = true; keep[n - 1] = true
    rdp(xs, ys, 0, far, tol, keep)
    rdp(xs, ys, far, n - 1, tol, keep)
    val vi = ArrayList<Int>()
    for (i in 0 until n) if (keep[i]) vi.add(i)
    // Drop the closing duplicate (end near start), and merge near-collinear vertices.
    if (vi.size >= 2 && hypot(xs[vi.last()] - xs[vi[0]], ys[vi.last()] - ys[vi[0]]) < 0.25f * diag) vi.removeAt(vi.size - 1)
    var changed = true
    while (changed && vi.size > 3) {
      changed = false
      for (k in vi.indices) {
        val p = vi[(k - 1 + vi.size) % vi.size]; val q = vi[k]; val r = vi[(k + 1) % vi.size]
        if (turnDegrees(xs[p], ys[p], xs[q], ys[q], xs[r], ys[r]) < 28.0) {
          vi.removeAt(k); changed = true; break
        }
      }
    }
    // A hand-drawn side often picks up a stray "corner". Keep dropping the
    // gentlest corner while the simpler polygon still fits the drawing well.
    while (vi.size > 3) {
      var weakest = -1
      var weakestTurn = Double.MAX_VALUE
      for (j in vi.indices) {
        val p = vi[(j - 1 + vi.size) % vi.size]; val q = vi[j]; val r = vi[(j + 1) % vi.size]
        val t = turnDegrees(xs[p], ys[p], xs[q], ys[q], xs[r], ys[r])
        if (t < weakestTurn) { weakestTurn = t; weakest = j }
      }
      val trial = ArrayList(vi).apply { removeAt(weakest) }
      val tx = FloatArray(trial.size) { xs[trial[it]] }
      val ty = FloatArray(trial.size) { ys[trial[it]] }
      var e = 0.0
      for (i in 0 until n) e += distToPolygon(xs[i], ys[i], tx, ty)
      if (e / n / diag < 0.03) vi.clear().also { vi.addAll(trial) } else break
    }
    val k = vi.size
    if (k != 3 && k != 4) return null
    var px = FloatArray(k) { xs[vi[it]] }
    var py = FloatArray(k) { ys[vi[it]] }
    var kind = if (k == 3) "triangle" else "quad"
    if (k == 4) {
      val rect = squareUp(px, py)
      if (rect != null) { px = rect.first; py = rect.second; kind = "rectangle" }
    }
    // Error: mean distance from the drawn points to the polygon's edges.
    var err = 0.0
    for (i in 0 until n) err += distToPolygon(xs[i], ys[i], px, py)
    err /= n
    val cx = px + px[0]
    val cy = py + py[0]
    return Pair(polyline(kind, cx, cy, true), (err / diag).toFloat())
  }

  private fun rdp(xs: FloatArray, ys: FloatArray, a: Int, b: Int, tol: Float, keep: BooleanArray) {
    if (b - a < 2) return
    var idx = -1; var maxD = 0f
    val dx = xs[b] - xs[a]; val dy = ys[b] - ys[a]
    val len = hypot(dx, dy)
    for (i in a + 1 until b) {
      val d = if (len < 1e-4f) hypot(xs[i] - xs[a], ys[i] - ys[a])
      else abs(dx * (ys[a] - ys[i]) - (xs[a] - xs[i]) * dy) / len
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = true
      rdp(xs, ys, a, idx, tol, keep)
      rdp(xs, ys, idx, b, tol, keep)
    }
  }

  private fun turnDegrees(ax: Float, ay: Float, bx: Float, by: Float, cx: Float, cy: Float): Double {
    val ux = bx - ax; val uy = by - ay; val vx = cx - bx; val vy = cy - by
    val lu = hypot(ux, uy); val lv = hypot(vx, vy)
    if (lu < 1e-4f || lv < 1e-4f) return 0.0
    val cosv = ((ux * vx + uy * vy) / (lu * lv)).toDouble().coerceIn(-1.0, 1.0)
    return Math.toDegrees(acos(cosv))
  }

  /**
   * A four-cornered shape whose corners are all near 90° becomes an exact
   * rectangle, aligned to its longest side (snapped level/upright within 4°).
   */
  private fun squareUp(px: FloatArray, py: FloatArray): Pair<FloatArray, FloatArray>? {
    for (i in 0 until 4) {
      val a = (i + 3) % 4; val c = (i + 1) % 4
      val turn = turnDegrees(px[a], py[a], px[i], py[i], px[c], py[c])
      if (abs(turn - 90.0) > 18.0) return null
    }
    var best = 0; var bestLen = 0f
    for (i in 0 until 4) {
      val l = hypot(px[(i + 1) % 4] - px[i], py[(i + 1) % 4] - py[i])
      if (l > bestLen) { bestLen = l; best = i }
    }
    var ang = atan2((py[(best + 1) % 4] - py[best]).toDouble(), (px[(best + 1) % 4] - px[best]).toDouble())
    val q = Math.round(ang / (PI / 2)) * (PI / 2)
    if (abs(ang - q) < Math.toRadians(4.0)) ang = q
    val c = cos(ang); val s = sin(ang)
    var cx = 0.0; var cy = 0.0
    for (i in 0 until 4) { cx += px[i]; cy += py[i] }
    cx /= 4; cy /= 4
    var minU = Double.MAX_VALUE; var maxU = -Double.MAX_VALUE
    var minV = Double.MAX_VALUE; var maxV = -Double.MAX_VALUE
    for (i in 0 until 4) {
      val dx = px[i] - cx; val dy = py[i] - cy
      val u = dx * c + dy * s; val v = -dx * s + dy * c
      minU = min(minU, u); maxU = max(maxU, u); minV = min(minV, v); maxV = max(maxV, v)
    }
    // Average opposite sides rather than taking the extremes.
    val hu = (maxU - minU) / 2 * 0.97; val hv = (maxV - minV) / 2 * 0.97
    val mu = (maxU + minU) / 2; val mv = (maxV + minV) / 2
    // Keep the user's starting corner and direction.
    val corners = arrayOf(doubleArrayOf(-hu, -hv), doubleArrayOf(hu, -hv), doubleArrayOf(hu, hv), doubleArrayOf(-hu, hv))
    val ox = FloatArray(4); val oy = FloatArray(4)
    for (i in 0 until 4) {
      val u = corners[i][0] + mu; val v = corners[i][1] + mv
      ox[i] = (cx + u * c - v * s).toFloat(); oy[i] = (cy + u * s + v * c).toFloat()
    }
    // Rotate so the corner nearest the original first vertex comes first.
    var start = 0; var sd = Float.MAX_VALUE
    for (i in 0 until 4) {
      val d = hypot(ox[i] - px[0], oy[i] - py[0]); if (d < sd) { sd = d; start = i }
    }
    val reverse = signedArea(px, py) * signedArea(ox, oy) < 0
    val rx = FloatArray(4); val ry = FloatArray(4)
    for (i in 0 until 4) {
      val j = if (reverse) (start - i + 4) % 4 else (start + i) % 4
      rx[i] = ox[j]; ry[i] = oy[j]
    }
    return Pair(rx, ry)
  }

  private fun distToPolygon(x: Float, y: Float, px: FloatArray, py: FloatArray): Double {
    var best = Double.MAX_VALUE
    for (i in px.indices) {
      val j = (i + 1) % px.size
      best = min(best, distToSeg(x, y, px[i], py[i], px[j], py[j]))
    }
    return best
  }

  private fun distToSeg(x: Float, y: Float, ax: Float, ay: Float, bx: Float, by: Float): Double {
    val dx = bx - ax; val dy = by - ay
    val l2 = dx * dx + dy * dy
    var t = if (l2 < 1e-6f) 0f else ((x - ax) * dx + (y - ay) * dy) / l2
    t = t.coerceIn(0f, 1f)
    return hypot((x - ax - t * dx).toDouble(), (y - ay - t * dy).toDouble())
  }

  /** Resample straight edges every STEP, keeping each corner as an exact vertex. */
  private fun polyline(kind: String, vx: FloatArray, vy: FloatArray, closed: Boolean): Shape {
    val ox = ArrayList<Float>(); val oy = ArrayList<Float>()
    for (i in 0 until vx.size - 1) {
      val len = hypot(vx[i + 1] - vx[i], vy[i + 1] - vy[i])
      val steps = max(1, (len / STEP).toInt())
      for (k in 0 until steps) {
        val t = k.toFloat() / steps
        ox.add(vx[i] + (vx[i + 1] - vx[i]) * t)
        oy.add(vy[i] + (vy[i + 1] - vy[i]) * t)
      }
    }
    ox.add(vx[vx.size - 1]); oy.add(vy[vy.size - 1])
    return Shape(kind, ox.toFloatArray(), oy.toFloatArray())
  }
}

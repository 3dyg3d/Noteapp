package expo.modules.geodesicink

import android.graphics.Path
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Line-for-line port of src/ink/geometry.ts and the path building in
 * src/ink/stroke.ts. The two MUST stay in step: the wet stroke drawn here is
 * replaced by the one JavaScript draws from the same points, and any
 * difference shows as a jump when the pen lifts.
 */

class InkPt(
  @JvmField var x: Float,
  @JvmField var y: Float,
  @JvmField val t: Double,
  @JvmField val p: Float,
  @JvmField var w: Float = 1f,
  /** Tilt from upright, radians; 0 when the digitiser doesn't report it. */
  @JvmField val a: Float = 0f
)

class ToolProfile(
  val minScale: Float,
  val maxScale: Float,
  val pressureWeight: Float,
  val speedWeight: Float,
  val taperStart: Float,
  val taperEnd: Float,
  val smoothing: Float,
  val pressureGamma: Float,
  val nibWeight: Float = 0f,
  val nibAngle: Float = 0f,
  val tiltGain: Float = 0f
) {
  val constantWidth: Boolean
    get() = minScale == 1f && maxScale == 1f && taperStart == 0f && taperEnd == 0f
}

object InkGeometry {
  private val PEN = ToolProfile(0.78f, 1.18f, 0.85f, 0.15f, 2.2f, 1.4f, 0.5f, 0.7f)
  private val PROFILES: Map<String, ToolProfile> = mapOf(
    "pen" to PEN,
    "fountain" to ToolProfile(0.3f, 1.8f, 0.7f, 0.3f, 4.5f, 3.5f, 0.45f, 0.8f),
    "marker" to ToolProfile(0.95f, 1.05f, 0.4f, 0f, 0.4f, 0.4f, 0.8f, 1f),
    "highlighter" to ToolProfile(1f, 1f, 0f, 0f, 0f, 0f, 1f, 1f),
    "pencil" to ToolProfile(0.65f, 1.15f, 0.85f, 0.15f, 2f, 1.5f, 0.5f, 0.75f, tiltGain = 1.2f),
    "fineliner" to ToolProfile(1f, 1f, 0f, 0f, 0f, 0f, 1f, 1f),
    "calligraphy" to ToolProfile(0.15f, 1.7f, 0.25f, 0f, 0.6f, 0.6f, 0.3f, 1f, 0.75f, (PI / 4).toFloat()),
    "brush" to ToolProfile(0.12f, 2.6f, 1f, 0f, 6f, 5f, 0.3f, 1.15f)
  )
  private val OPACITY: Map<String, Float> = mapOf(
    "pen" to 1f, "fountain" to 1f, "marker" to 0.92f, "highlighter" to 0.35f, "pencil" to 0.78f,
    "fineliner" to 1f, "calligraphy" to 1f, "brush" to 0.96f
  )

  private const val FAST_SPEED = 2.2f
  private const val CORNER_THRESHOLD = PI / 2.2
  private const val SPEED_WINDOW = 3
  private const val CAP_STEPS = 6

  fun profile(tool: String): ToolProfile = PROFILES[tool] ?: PEN
  fun opacity(tool: String): Float = OPACITY[tool] ?: 1f
  fun effectiveWidth(tool: String, width: Float): Float = if (tool == "highlighter") width * 2.4f else width

  private fun clamp01(v: Float): Float = if (v < 0f) 0f else if (v > 1f) 1f else v
  private fun dist(a: InkPt, b: InkPt): Float = hypot(b.x - a.x, b.y - a.y)

  /** Fix the width factor of pts[i]; every earlier point already has one. */
  fun annotateWidth(pts: List<InkPt>, i: Int, prof: ToolProfile) {
    val cur = pts[i]
    val range = prof.maxScale - prof.minScale
    var speedTerm = 1f
    if (i > 0) {
      val j = max(0, i - SPEED_WINDOW)
      var len = 0f
      for (k in j + 1..i) len += dist(pts[k - 1], pts[k])
      val dt = max(1.0, cur.t - pts[j].t).toFloat()
      speedTerm = 1f - clamp01(len / dt / FAST_SPEED)
    }
    val pressureTerm = clamp01(cur.p).toDouble().pow(prof.pressureGamma.toDouble()).toFloat()
    var nibTerm = 0.5f
    if (prof.nibWeight > 0f && i > 0) {
      val a = pts[max(0, i - SPEED_WINDOW)]
      val dx = cur.x - a.x
      val dy = cur.y - a.y
      if (abs(dx) + abs(dy) > 1e-6f) {
        nibTerm = abs(sin(atan2(dy.toDouble(), dx.toDouble()) - prof.nibAngle.toDouble())).toFloat()
      }
    }
    val total = (prof.pressureWeight + prof.speedWeight + prof.nibWeight).let { if (it == 0f) 1f else it }
    val mix = (pressureTerm * prof.pressureWeight + speedTerm * prof.speedWeight + nibTerm * prof.nibWeight) / total
    val tiltTerm = 1f + prof.tiltGain * clamp01(cur.a / (PI / 3).toFloat())
    val target = (prof.minScale + range * mix) * tiltTerm
    val w = if (i == 0) target else pts[i - 1].w + (target - pts[i - 1].w) * (1f - prof.smoothing)
    cur.w = (w * 1000f).roundToInt() / 1000f
  }

  private fun taperEase(u: Float): Float {
    val v = clamp01(u)
    return 0.16f + 0.84f * (v * (2f - v))
  }

  /** Length of the exit taper for a finished stroke with these points. */
  fun endTaperLength(pts: List<InkPt>, baseWidth: Float, prof: ToolProfile): Float {
    var total = 0f
    for (i in 1 until pts.size) total += dist(pts[i - 1], pts[i])
    return min(prof.taperEnd * baseWidth, total * 0.4f)
  }

  internal fun taperFactors(pts: List<InkPt>, baseWidth: Float, prof: ToolProfile, finished: Boolean): FloatArray {
    val n = pts.size
    val s = FloatArray(n)
    for (i in 1 until n) s[i] = s[i - 1] + dist(pts[i - 1], pts[i])
    val total = s[n - 1]
    val startLen = min(prof.taperStart * baseWidth, total * 0.4f)
    val endLen = if (finished) min(prof.taperEnd * baseWidth, total * 0.4f) else 0f
    val out = FloatArray(n)
    for (i in 0 until n) {
      var k = 1f
      if (startLen > 0f && s[i] < startLen) k *= taperEase(s[i] / startLen)
      if (endLen > 0f && total - s[i] < endLen) k *= taperEase((total - s[i]) / endLen)
      out[i] = k
    }
    return out
  }

  /** Unit normals (nx, ny interleaved), averaged across adjacent segments. */
  internal fun normals(xs: FloatArray, ys: FloatArray): FloatArray {
    val n = xs.size
    val segN = FloatArray(max(0, n - 1) * 2)
    for (i in 1 until n) {
      val dx = xs[i] - xs[i - 1]
      val dy = ys[i] - ys[i - 1]
      var len = hypot(dx, dy)
      if (len == 0f) len = 1f
      segN[(i - 1) * 2] = -dy / len
      segN[(i - 1) * 2 + 1] = dx / len
    }
    val out = FloatArray(n * 2)
    val segCount = n - 1
    for (i in 0 until n) {
      var ax = 0f; var ay = 1f; var bx = 0f; var by = 1f
      if (segCount > 0) {
        val ia = if (i - 1 >= 0) i - 1 else 0
        val ib = if (i < segCount) i else segCount - 1
        ax = segN[ia * 2]; ay = segN[ia * 2 + 1]
        bx = segN[ib * 2]; by = segN[ib * 2 + 1]
      }
      val nx = ax + bx
      val ny = ay + by
      val len = hypot(nx, ny)
      if (len < 1e-6f) {
        out[i * 2] = ax; out[i * 2 + 1] = ay
      } else {
        out[i * 2] = nx / len; out[i * 2 + 1] = ny / len
      }
    }
    return out
  }

  private fun corners(xs: FloatArray, ys: FloatArray): BooleanArray {
    val n = xs.size
    val out = BooleanArray(n)
    for (i in 1 until n - 1) {
      val a1 = atan2((ys[i] - ys[i - 1]).toDouble(), (xs[i] - xs[i - 1]).toDouble())
      val a2 = atan2((ys[i + 1] - ys[i]).toDouble(), (xs[i + 1] - xs[i]).toDouble())
      var d = abs(a2 - a1)
      if (d > PI) d = 2 * PI - d
      out[i] = d > CORNER_THRESHOLD
    }
    return out
  }

  /** Catmull-Rom through the points as cubic Béziers; corners break the spline. */
  private fun appendSpine(path: Path, xs: FloatArray, ys: FloatArray, cr: BooleanArray, move: Boolean) {
    val n = xs.size
    if (n == 0) return
    if (move) path.moveTo(xs[0], ys[0]) else path.lineTo(xs[0], ys[0])
    if (n == 2) {
      path.lineTo(xs[1], ys[1])
      return
    }
    for (i in 0 until n - 1) {
      val i0 = if (i - 1 >= 0) i - 1 else i
      val i3 = if (i + 2 < n) i + 2 else i + 1
      if (cr[i] || cr[i + 1]) {
        path.lineTo(xs[i + 1], ys[i + 1])
        continue
      }
      path.cubicTo(
        xs[i] + (xs[i + 1] - xs[i0]) / 6f,
        ys[i] + (ys[i + 1] - ys[i0]) / 6f,
        xs[i + 1] - (xs[i3] - xs[i]) / 6f,
        ys[i + 1] - (ys[i3] - ys[i]) / 6f,
        xs[i + 1],
        ys[i + 1]
      )
    }
  }

  private fun reversed(a: FloatArray): FloatArray = FloatArray(a.size) { a[a.size - 1 - it] }
  private fun reversed(a: BooleanArray): BooleanArray = BooleanArray(a.size) { a[a.size - 1 - it] }

  /**
   * Build the stroke path in world units. For constant-width tools it is a
   * spine to be STROKED; otherwise a closed outline to be FILLED.
   */
  /** Everything needed to draw a variable-width stroke, or any piece of it. */
  class OutlineData(
    @JvmField val n: Int,
    @JvmField val xs: FloatArray, @JvmField val ys: FloatArray,
    @JvmField val hw: FloatArray, @JvmField val nrm: FloatArray, @JvmField val cr: BooleanArray,
    @JvmField val rx: FloatArray, @JvmField val ry: FloatArray,
    @JvmField val lx: FloatArray, @JvmField val ly: FloatArray
  )

  /** Null for fewer than two points or constant-width tools (those are stroked spines). */
  fun computeOutline(pts: List<InkPt>, baseWidth: Float, tool: String, finished: Boolean, noTaper: Boolean = false): OutlineData? {
    val n = pts.size
    val prof = profile(tool)
    if (n < 2 || prof.constantWidth) return null
    val xs = FloatArray(n) { pts[it].x }
    val ys = FloatArray(n) { pts[it].y }
    // Snapped shapes are drawn at an even width: no entry or exit taper.
    val taper = if (noTaper) FloatArray(n) { 1f } else taperFactors(pts, baseWidth, prof, finished)
    val nrm = normals(xs, ys)
    val cr = corners(xs, ys)
    val half = baseWidth / 2f
    val hw = FloatArray(n) { max(0.15f, half * pts[it].w * taper[it]) }
    val rx = FloatArray(n); val ry = FloatArray(n)
    val lx = FloatArray(n); val ly = FloatArray(n)
    for (i in 0 until n) {
      val nx = nrm[i * 2]; val ny = nrm[i * 2 + 1]
      rx[i] = xs[i] + nx * hw[i]; ry[i] = ys[i] + ny * hw[i]
      lx[i] = xs[i] - nx * hw[i]; ly[i] = ys[i] - ny * hw[i]
    }
    return OutlineData(n, xs, ys, hw, nrm, cr, rx, ry, lx, ly)
  }

  /**
   * Build the stroke path in world units. For constant-width tools it is a
   * spine to be STROKED; otherwise a closed outline to be FILLED.
   */
  fun buildPath(pts: List<InkPt>, baseWidth: Float, tool: String, finished: Boolean, noTaper: Boolean = false): Path {
    val path = Path()
    val n = pts.size
    if (n == 0) return path
    val prof = profile(tool)
    if (n == 1) {
      path.addCircle(pts[0].x, pts[0].y, max(0.4f, (baseWidth / 2f) * pts[0].w), Path.Direction.CW)
      return path
    }
    if (prof.constantWidth) {
      val xs = FloatArray(n) { pts[it].x }
      val ys = FloatArray(n) { pts[it].y }
      appendSpine(path, xs, ys, corners(xs, ys), true)
      return path
    }
    val d = computeOutline(pts, baseWidth, tool, finished, noTaper) ?: return path
    appendSpine(path, d.rx, d.ry, d.cr, true)
    capInto(path, d.xs[n - 1], d.ys[n - 1], d.nrm[(n - 1) * 2], d.nrm[(n - 1) * 2 + 1], d.hw[n - 1], 1f)
    appendSpine(path, reversed(d.lx), reversed(d.ly), reversed(d.cr), false)
    capInto(path, d.xs[0], d.ys[0], d.nrm[0], d.nrm[1], d.hw[0], -1f)
    path.close()
    addFoldPatches(path, d.xs, d.ys, d.hw, d.cr, d.rx, d.ry, d.lx, d.ly)
    return path
  }

  /**
   * The exact outline of segments a..b (a segment k runs from point k to k+1),
   * using the same spline as the full outline, so pieces drawn one after another
   * add up to exactly the full stroke. Closed across both ends with straight
   * lines, which lie inside the stroke.
   */
  fun piecePath(d: OutlineData, a: Int, b: Int): Path {
    val path = Path()
    val n = d.n
    if (a > b || a < 0 || b > n - 2) return path
    path.moveTo(d.rx[a], d.ry[a])
    for (k in a..b) splineSeg(path, d.rx, d.ry, d.cr, k, k + 1, if (k - 1 >= 0) k - 1 else k, if (k + 2 < n) k + 2 else k + 1)
    path.lineTo(d.lx[b + 1], d.ly[b + 1])
    // Back along the left side: from point k+1 to k; the reversed spline's
    // neighbours are k+2 (before) and k-1 (after).
    for (k in b downTo a) splineSeg(path, d.lx, d.ly, d.cr, k + 1, k, if (k + 2 < n) k + 2 else k + 1, if (k - 1 >= 0) k - 1 else k)
    path.close()
    return path
  }

  /** One Catmull-Rom segment p1 -> p2 with neighbours p0, p3 (indices); straight if at a corner. */
  private fun splineSeg(path: Path, x: FloatArray, y: FloatArray, cr: BooleanArray, i1: Int, i2: Int, i0: Int, i3: Int) {
    if (cr[i1] || cr[i2]) {
      path.lineTo(x[i2], y[i2])
      return
    }
    path.cubicTo(
      x[i1] + (x[i2] - x[i0]) / 6f, y[i1] + (y[i2] - y[i0]) / 6f,
      x[i2] - (x[i3] - x[i1]) / 6f, y[i2] - (y[i3] - y[i1]) / 6f,
      x[i2], y[i2]
    )
  }

  /** The straight piece of segment k along its own normal. Lies inside the final outline. */
  fun segmentQuadPath(d: OutlineData, k: Int): Path {
    val path = Path()
    if (k < 0 || k > d.n - 2) return path
    val dx = d.xs[k + 1] - d.xs[k]
    val dy = d.ys[k + 1] - d.ys[k]
    var len = hypot(dx, dy)
    if (len == 0f) len = 1f
    val nx = -dy / len
    val ny = dx / len
    path.moveTo(d.xs[k] + nx * d.hw[k], d.ys[k] + ny * d.hw[k])
    path.lineTo(d.xs[k + 1] + nx * d.hw[k + 1], d.ys[k + 1] + ny * d.hw[k + 1])
    path.lineTo(d.xs[k + 1] - nx * d.hw[k + 1], d.ys[k + 1] - ny * d.hw[k + 1])
    path.lineTo(d.xs[k] - nx * d.hw[k], d.ys[k] - ny * d.hw[k])
    path.close()
    return path
  }

  /** Spine segments a..b (constant-width tools), same spline as the full spine. */
  fun spinePiecePath(pts: List<InkPt>, a: Int, b: Int): Path {
    val path = Path()
    val n = pts.size
    if (a > b || a < 0 || b > n - 2) return path
    val xs = FloatArray(n) { pts[it].x }
    val ys = FloatArray(n) { pts[it].y }
    val cr = corners(xs, ys)
    path.moveTo(xs[a], ys[a])
    if (n == 2) {
      path.lineTo(xs[1], ys[1])
      return path
    }
    for (k in a..b) splineSeg(path, xs, ys, cr, k, k + 1, if (k - 1 >= 0) k - 1 else k, if (k + 2 < n) k + 2 else k + 1)
    return path
  }

  /** Which segments get a fold patch (see addFoldPatches). */
  fun patchFlags(d: OutlineData): BooleanArray = foldFlags(d.xs, d.ys, d.hw, d.cr) ?: BooleanArray(max(0, d.n - 1))

  /** Segments to patch, or null when the stroke has no folds. */
  private fun foldFlags(xs: FloatArray, ys: FloatArray, hw: FloatArray, cr: BooleanArray): BooleanArray? {
    val n = xs.size
    if (n < 3) return null
    val patchSeg = BooleanArray(n - 1)
    var any = false
    for (i in 1 until n - 1) {
      val l1 = hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
      val l2 = hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i])
      if (l1 == 0f || l2 == 0f) continue
      val cosv = ((xs[i] - xs[i - 1]) * (xs[i + 1] - xs[i]) + (ys[i] - ys[i - 1]) * (ys[i + 1] - ys[i])) / (l1 * l2)
      val theta = kotlin.math.acos(cosv.coerceIn(-1f, 1f).toDouble()).toFloat()
      val widthJump = max(abs(hw[i] - hw[i - 1]) / l1, abs(hw[i + 1] - hw[i]) / l2)
      if (cr[i] || hw[i] * 2f * sin(theta / 2f) > min(l1, l2) * 0.5f || widthJump > 0.5f) {
        any = true
        val reach = 2f * hw[i]
        patchSeg[i - 1] = true
        patchSeg[i] = true
        var k = i - 1
        var d = l1
        while (k > 0 && d < reach) {
          patchSeg[k - 1] = true
          d += hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1])
          k--
        }
        k = i + 1
        d = l2
        while (k < n - 1 && d < reach) {
          patchSeg[k] = true
          d += hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k])
          k++
        }
      }
    }
    return if (any) patchSeg else null
  }

  /**
   * Same as Outline.patches in geometry.ts: where the stroke turns more tightly
   * than it is wide, or its width changes faster than it advances, the inner
   * edge folds back and the fold cancels under the fill rule. Cover those
   * spans with the straight segment pieces, wound like the ring.
   */
  private fun addFoldPatches(
    path: Path, xs: FloatArray, ys: FloatArray, hw: FloatArray, cr: BooleanArray,
    rx: FloatArray, ry: FloatArray, lx: FloatArray, ly: FloatArray
  ) {
    val n = xs.size
    val patchSeg = foldFlags(xs, ys, hw, cr) ?: return
    // Ring orientation: shoelace over right side forward, left side back.
    var area = 0.0
    val m = n * 2
    for (idx in 0 until m) {
      val px = if (idx < n) rx[idx] else lx[m - 1 - idx]
      val py = if (idx < n) ry[idx] else ly[m - 1 - idx]
      val j = (idx + 1) % m
      val qx = if (j < n) rx[j] else lx[m - 1 - j]
      val qy = if (j < n) ry[j] else ly[m - 1 - j]
      area += (px * qy - qx * py).toDouble()
    }
    val clockwise = area > 0
    val qxArr = FloatArray(4)
    val qyArr = FloatArray(4)
    for (k in 0 until n - 1) {
      if (!patchSeg[k]) continue
      val dx = xs[k + 1] - xs[k]
      val dy = ys[k + 1] - ys[k]
      var len = hypot(dx, dy)
      if (len == 0f) len = 1f
      val nx = -dy / len
      val ny = dx / len
      qxArr[0] = xs[k] + nx * hw[k]; qyArr[0] = ys[k] + ny * hw[k]
      qxArr[1] = xs[k + 1] + nx * hw[k + 1]; qyArr[1] = ys[k + 1] + ny * hw[k + 1]
      qxArr[2] = xs[k + 1] - nx * hw[k + 1]; qyArr[2] = ys[k + 1] - ny * hw[k + 1]
      qxArr[3] = xs[k] - nx * hw[k]; qyArr[3] = ys[k] - ny * hw[k]
      var qa = 0f
      for (t in 0 until 4) {
        val u = (t + 1) % 4
        qa += qxArr[t] * qyArr[u] - qxArr[u] * qyArr[t]
      }
      if ((qa > 0f) == clockwise) {
        path.moveTo(qxArr[0], qyArr[0])
        for (t in 1 until 4) path.lineTo(qxArr[t], qyArr[t])
      } else {
        path.moveTo(qxArr[3], qyArr[3])
        for (t in 2 downTo 0) path.lineTo(qxArr[t], qyArr[t])
      }
      path.close()
    }
  }

  /** Semicircle from +n (sign 1) or -n (sign -1) around the end, excluding both ends. */
  private fun capInto(path: Path, cx: Float, cy: Float, nx: Float, ny: Float, r: Float, sign: Float) {
    val dx = ny * sign
    val dy = -nx * sign
    val nsx = nx * sign
    val nsy = ny * sign
    for (k in 1 until CAP_STEPS) {
      val th = PI * k / CAP_STEPS
      val c = cos(th).toFloat()
      val s = sin(th).toFloat()
      path.lineTo(cx + (nsx * c + dx * s) * r, cy + (nsy * c + dy * s) * r)
    }
  }
}

/** One Euro filter on x and y, same parameters as src/ink/geometry.ts. */
class OneEuro2D(
  private val minCutoff: Double = 5.0,
  private val beta: Double = 0.2,
  private val dCutoff: Double = 1.0
) {
  private var x = 0.0
  private var y = 0.0
  private var dx = 0.0
  private var dy = 0.0
  private var t = -1.0

  fun reset() {
    t = -1.0
  }

  private fun alpha(cutoff: Double, dtSec: Double): Double {
    val tau = 1.0 / (2.0 * PI * cutoff)
    return 1.0 / (1.0 + tau / dtSec)
  }

  /** Returns the filtered position in `out` (x, y). */
  fun filter(inX: Double, inY: Double, tMs: Double, out: DoubleArray) {
    if (t < 0) {
      x = inX; y = inY; dx = 0.0; dy = 0.0; t = tMs
      out[0] = inX; out[1] = inY
      return
    }
    val dt = max(0.0005, (tMs - t) / 1000.0)
    t = tMs
    val ad = alpha(dCutoff, dt)
    dx += ad * ((inX - x) / dt - dx)
    dy += ad * ((inY - y) / dt - dy)
    val speed = hypot(dx, dy)
    val a = alpha(minCutoff + beta * speed, dt)
    x += a * (inX - x)
    y += a * (inY - y)
    out[0] = x; out[1] = y
  }
}

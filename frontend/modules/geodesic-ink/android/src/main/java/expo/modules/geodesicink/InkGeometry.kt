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
  @JvmField var w: Float = 1f
)

class ToolProfile(
  val minScale: Float,
  val maxScale: Float,
  val pressureWeight: Float,
  val speedWeight: Float,
  val taperStart: Float,
  val taperEnd: Float,
  val smoothing: Float,
  val pressureGamma: Float
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
    "pencil" to ToolProfile(0.65f, 1.15f, 0.85f, 0.15f, 2f, 1.5f, 0.5f, 0.75f)
  )
  private val OPACITY: Map<String, Float> = mapOf(
    "pen" to 1f, "fountain" to 1f, "marker" to 0.92f, "highlighter" to 0.35f, "pencil" to 0.78f
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
    val total = (prof.pressureWeight + prof.speedWeight).let { if (it == 0f) 1f else it }
    val mix = (pressureTerm * prof.pressureWeight + speedTerm * prof.speedWeight) / total
    val target = prof.minScale + range * mix
    val w = if (i == 0) target else pts[i - 1].w + (target - pts[i - 1].w) * (1f - prof.smoothing)
    cur.w = (w * 1000f).roundToInt() / 1000f
  }

  private fun taperEase(u: Float): Float {
    val v = clamp01(u)
    return 0.16f + 0.84f * (v * (2f - v))
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
  fun buildPath(pts: List<InkPt>, baseWidth: Float, tool: String, finished: Boolean): Path {
    val path = Path()
    val n = pts.size
    if (n == 0) return path
    val prof = profile(tool)
    if (n == 1) {
      path.addCircle(pts[0].x, pts[0].y, max(0.4f, (baseWidth / 2f) * pts[0].w), Path.Direction.CW)
      return path
    }
    val xs = FloatArray(n) { pts[it].x }
    val ys = FloatArray(n) { pts[it].y }
    if (prof.constantWidth) {
      appendSpine(path, xs, ys, corners(xs, ys), true)
      return path
    }

    val taper = taperFactors(pts, baseWidth, prof, finished)
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

    appendSpine(path, rx, ry, cr, true)
    capInto(path, xs[n - 1], ys[n - 1], nrm[(n - 1) * 2], nrm[(n - 1) * 2 + 1], hw[n - 1], 1f)
    appendSpine(path, reversed(lx), reversed(ly), reversed(cr), false)
    capInto(path, xs[0], ys[0], nrm[0], nrm[1], hw[0], -1f)
    path.close()
    return path
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

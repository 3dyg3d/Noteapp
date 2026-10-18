package expo.modules.geodesicink

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Shader
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Pencil grain. Byte-for-byte the same tile as src/ink/grainNoise.ts, so the
 * native wet stroke and the stroke Skia draws once saved look identical.
 */
object InkGrain {
  const val SIZE = 64
  const val SCALE = 0.4f

  val alpha: IntArray by lazy {
    val n = SIZE
    var x = 0x9e3779b9.toInt()
    val r = DoubleArray(n * n)
    for (i in 0 until n * n) {
      x = x xor (x shl 13)
      x = x xor (x ushr 17)
      x = x xor (x shl 5)
      r[i] = (x.toLong() and 0xffffffffL).toDouble() / 4294967296.0
    }
    val out = IntArray(n * n)
    for (y in 0 until n) {
      for (xx in 0 until n) {
        var sum = 0.0
        for (dy in -1..1) for (dx in -1..1) {
          sum += r[((y + dy + n) % n) * n + ((xx + dx + n) % n)]
        }
        val v = sum / 9.0
        val a = min(1.0, max(0.0, 0.75 + (v - 0.5) * 3.5))
        out[y * n + xx] = floor(a * 255.0 + 0.5).toInt()
      }
    }
    out
  }

  private val shaders = HashMap<Int, BitmapShader>()

  /** A repeating shader of the grain in `color`, mapped to world units. */
  fun shader(color: Int): BitmapShader = synchronized(shaders) {
    shaders.getOrPut(color) {
      val n = SIZE
      val ca = Color.alpha(color)
      val pixels = IntArray(n * n) {
        Color.argb((alpha[it] * ca + 127) / 255, Color.red(color), Color.green(color), Color.blue(color))
      }
      val bmp = Bitmap.createBitmap(pixels, n, n, Bitmap.Config.ARGB_8888)
      BitmapShader(bmp, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
        setLocalMatrix(Matrix().apply { setScale(SCALE, SCALE) })
      }
    }
  }
}

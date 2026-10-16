package com.mediaconlab.pixie.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val PixiePink = Color(0xFFFF8FB1)
val PixieViolet = Color(0xFF7C5CFF)
val PixieGreen = Color(0xFF2EB67D)
val PixieAmber = Color(0xFFF2A93B)

private val LightColors = lightColorScheme(
    primary = PixieViolet,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE6DEFF),
    onPrimaryContainer = Color(0xFF22005D),
    secondary = Color(0xFFC2416E),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFD9E2),
    onSecondaryContainer = Color(0xFF3E0021),
    background = Color(0xFFFFFBFF),
    surface = Color(0xFFFFFBFF),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFCABEFF),
    onPrimary = Color(0xFF390094),
    primaryContainer = Color(0xFF5225D4),
    onPrimaryContainer = Color(0xFFE6DEFF),
    secondary = Color(0xFFFFB1C8),
    onSecondary = Color(0xFF5E1137),
    secondaryContainer = Color(0xFF7B294E),
    onSecondaryContainer = Color(0xFFFFD9E2),
)

@Composable
fun PixieTheme(content: @Composable () -> Unit) {
    // Fixed brand palette (no dynamic colour) so Pixie looks the same on every phone.
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}

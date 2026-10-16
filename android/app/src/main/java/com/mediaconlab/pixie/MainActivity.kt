package com.mediaconlab.pixie

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mediaconlab.pixie.ui.PixieAmber
import com.mediaconlab.pixie.ui.PixieGreen
import com.mediaconlab.pixie.ui.PixiePink
import com.mediaconlab.pixie.ui.PixieTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity() {

    /** Bumped in onResume so permission cards re-check their live status after returning from Settings. */
    private var resumeTick by mutableIntStateOf(0)
    private var paired by mutableStateOf(false)
    private var pendingLink by mutableStateOf<Pairing.Link?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        paired = Prefs.isPaired(this)
        pendingLink = Pairing.parseLink(intent?.data)
        if (paired) LinkService.start(this)

        setContent {
            PixieTheme {
                PixieApp(
                    resumeTick = resumeTick,
                    paired = paired,
                    pendingLink = pendingLink,
                    onLinkConsumed = { pendingLink = null },
                    onPaired = {
                        paired = true
                        LinkService.start(this@MainActivity)
                    },
                    onUnpair = { unpair() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val link = Pairing.parseLink(intent.data)
        if (link != null) pendingLink = link
    }

    override fun onResume() {
        super.onResume()
        resumeTick++
        paired = Prefs.isPaired(this)
        // Picks up a permission granted in the dialog or in Settings, and (API 34+) lets a link service that was
        // started at boot add the location type now that the app is visible.
        if (paired) LinkService.locationSettingsChanged(this)
    }

    private fun unpair() {
        val base = Prefs.baseUrl(this)
        val token = Prefs.token(this)
        val deviceId = Prefs.deviceId(this)
        LinkService.stop(this)
        PixieLink.stop(clearQueue = true)
        Prefs.clearPairing(this)
        NotificationStore.clear()
        EventLog.clear()
        paired = false
        if (base != null && token != null) {
            Thread { Pairing.revoke(base, token, deviceId) }.start()
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------------------

@Composable
private fun PixieApp(
    resumeTick: Int,
    paired: Boolean,
    pendingLink: Pairing.Link?,
    onLinkConsumed: () -> Unit,
    onPaired: () -> Unit,
    onUnpair: () -> Unit,
) {
    Scaffold(modifier = Modifier.fillMaxSize()) { inner ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = inner.calculateTopPadding() + 16.dp,
                bottom = inner.calculateBottomPadding() + 24.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Header() }
            if (paired) {
                item { StatusCard(onUnpair = onUnpair) }
                item { ToggleCard(resumeTick = resumeTick) }
            } else {
                item { PairCard(pendingLink = pendingLink, onLinkConsumed = onLinkConsumed, onPaired = onPaired) }
            }
            item { SectionTitle("Setup") }
            item { PermissionCards(resumeTick = resumeTick) }
            if (paired) {
                item { SectionTitle("Recent activity") }
                item { RecentEvents() }
            }
            item { PrivacyNote() }
        }
    }
}

@Composable
private fun Header() {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
        BlobFace(Modifier.size(56.dp))
        Spacer(Modifier.width(14.dp))
        Column {
            Text("Pixie", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                "Phone link for your desktop companion",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun BlobFace(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        drawCircle(color = PixiePink, radius = w / 2f, center = Offset(w / 2f, h / 2f))
        val eye = Color(0xFF2B2140)
        drawCircle(color = eye, radius = w * 0.07f, center = Offset(w * 0.36f, h * 0.44f))
        drawCircle(color = eye, radius = w * 0.07f, center = Offset(w * 0.64f, h * 0.44f))
        drawArc(
            color = eye,
            startAngle = 20f,
            sweepAngle = 140f,
            useCenter = false,
            topLeft = Offset(w * 0.38f, h * 0.46f),
            size = Size(w * 0.24f, h * 0.18f),
            style = Stroke(width = w * 0.05f, cap = StrokeCap.Round),
        )
        drawCircle(color = Color(0x55FF4F7B), radius = w * 0.07f, center = Offset(w * 0.24f, h * 0.58f))
        drawCircle(color = Color(0x55FF4F7B), radius = w * 0.07f, center = Offset(w * 0.76f, h * 0.58f))
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp),
    )
}

// ---- Pairing -----------------------------------------------------------------------------------------------

@Composable
private fun PairCard(pendingLink: Pairing.Link?, onLinkConsumed: () -> Unit, onPaired: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(Prefs.lastUrl(context)) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun pair(u: String, c: String) {
        if (busy) return
        busy = true
        error = null
        val appContext = context.applicationContext
        scope.launch {
            val result = withContext(Dispatchers.IO) { Pairing.claim(appContext, u, c) }
            busy = false
            when (result) {
                is Pairing.Result.Ok -> {
                    EventLog.add("link", "Paired", result.baseUrl)
                    onPaired()
                }
                is Pairing.Result.Error -> error = result.message
            }
        }
    }

    // Deep link pixie://pair?u=...&c=... pre-fills and pairs automatically.
    LaunchedEffect(pendingLink) {
        val link = pendingLink
        if (link != null) {
            url = link.baseUrl
            code = link.code
            onLinkConsumed()
            pair(link.baseUrl, link.code)
        }
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "Pair with your Pixie",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Text(
                "On your Mac, open Pixie → Pair phone. Scan the QR code with your camera, or type the brain URL " +
                    "and the 6-digit code here.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Brain URL") },
                placeholder = { Text("https://pixie-orchestrator.you.workers.dev") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
            )
            OutlinedTextField(
                value = code,
                onValueChange = { v -> code = v.filter { it.isDigit() }.take(6) },
                label = { Text("6-digit code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
                enabled = !busy,
            )
            val err = error
            if (err != null) {
                Text(err, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            Button(
                onClick = { pair(url, code) },
                enabled = !busy && url.isNotBlank() && code.length == 6,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("Pairing…")
                } else {
                    Text("Pair")
                }
            }
        }
    }
}

// ---- Paired: status, toggles, events ------------------------------------------------------------------------

@Composable
private fun StatusCard(onUnpair: () -> Unit) {
    val context = LocalContext.current
    val state by PixieLink.state.collectAsState()
    var confirm by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Brain", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                ConnectionChip(state)
            }
            Text(
                Prefs.baseUrl(context) ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = {
                    PixieLink.reconnectNow(userInitiated = true)
                    LinkService.start(context)
                }) { Text("Reconnect") }
                if (confirm) {
                    Button(onClick = {
                        confirm = false
                        onUnpair()
                    }) { Text("Really unpair") }
                    TextButton(onClick = { confirm = false }) { Text("Cancel") }
                } else {
                    OutlinedButton(onClick = { confirm = true }) { Text("Unpair") }
                }
            }
        }
    }
}

@Composable
private fun ConnectionChip(state: LinkState) {
    val (label, color) = when (state) {
        LinkState.CONNECTED -> "Connected" to PixieGreen
        LinkState.CONNECTING -> "Connecting…" to PixieAmber
        LinkState.DISCONNECTED -> "Offline" to MaterialTheme.colorScheme.error
    }
    Surface(
        shape = RoundedCornerShape(50),
        color = color.copy(alpha = 0.15f),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Box(
                Modifier
                    .size(8.dp)
                    .background(color, CircleShape)
            )
            Spacer(Modifier.width(6.dp))
            Text(label, style = MaterialTheme.typography.labelLarge, color = color)
        }
    }
}

@Composable
private fun ToggleCard(resumeTick: Int) {
    val context = LocalContext.current
    var shareLocation by remember { mutableStateOf(Prefs.shareLocation(context)) }
    val locationPermitted = remember(resumeTick) { Permissions.locationGranted(context) }
    var whatsapp by remember { mutableStateOf(Prefs.forwardWhatsApp(context)) }
    var sms by remember { mutableStateOf(Prefs.forwardSms(context)) }
    var calls by remember { mutableStateOf(Prefs.forwardCalls(context)) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(vertical = 8.dp)) {
            ToggleRow(Icons.Filled.Face, "Forward WhatsApp", "Message previews from WhatsApp & Business", whatsapp) {
                whatsapp = it
                Prefs.setForwardWhatsApp(context, it)
            }
            HorizontalDivider(Modifier.padding(horizontal = 16.dp))
            ToggleRow(Icons.Filled.Email, "Forward SMS", "Previews from your default SMS app", sms) {
                sms = it
                Prefs.setForwardSms(context, it)
            }
            HorizontalDivider(Modifier.padding(horizontal = 16.dp))
            ToggleRow(Icons.Filled.Call, "Forward calls", "Ringing, answered, ended and missed calls", calls) {
                calls = it
                Prefs.setForwardCalls(context, it)
            }
            HorizontalDivider(Modifier.padding(horizontal = 16.dp))
            ToggleRow(
                Icons.Filled.LocationOn,
                "Share location for weather",
                if (locationPermitted) "Rounded to about 1 km, at most every 15 minutes" else "Needs location access (see Setup)",
                shareLocation,
            ) {
                shareLocation = it
                Prefs.setShareLocation(context, it)
                LinkService.locationSettingsChanged(context)
            }
        }
    }
}

@Composable
private fun ToggleRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun RecentEvents() {
    val entries by EventLog.entries.collectAsState()
    Card(modifier = Modifier.fillMaxWidth()) {
        if (entries.isEmpty()) {
            Text(
                "Nothing yet. Calls and messages Pixie sees will show up here.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
            )
        } else {
            Column(Modifier.padding(vertical = 4.dp)) {
                entries.forEachIndexed { index, e ->
                    if (index > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    EventRow(e)
                }
            }
        }
    }
}

@Composable
private fun EventRow(e: LogEntry) {
    val icon = when (e.kind) {
        "call" -> Icons.Filled.Phone
        "message" -> Icons.Filled.Email
        "location" -> Icons.Filled.LocationOn
        "exec" -> Icons.Filled.CheckCircle
        else -> Icons.Filled.Info
    }
    val time = remember(e.ts) { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(e.ts)) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.secondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(e.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (e.detail.isNotBlank()) {
                Text(
                    e.detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ---- Permissions ----------------------------------------------------------------------------------------------

@Composable
private fun PermissionCards(resumeTick: Int) {
    val context = LocalContext.current
    // Re-read whenever we come back from Settings (resumeTick) or a runtime dialog closes (localTick).
    var localTick by remember { mutableIntStateOf(0) }
    val tick = resumeTick + localTick

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        localTick++
    }
    val locationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        localTick++
        LinkService.locationSettingsChanged(context)
    }

    val notifAccess = remember(tick) { Permissions.notificationAccess(context) }
    val phone = remember(tick) { Permissions.phoneGranted(context) }
    val post = remember(tick) { Permissions.postNotificationsGranted(context) }
    val battery = remember(tick) { Permissions.batteryUnrestricted(context) }
    val location = remember(tick) { Permissions.locationGranted(context) }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        PermissionCard(
            icon = Icons.Filled.Notifications,
            title = "Notification access",
            body = "Lets Pixie read WhatsApp and SMS previews and use their Reply button when you approve a reply.",
            granted = notifAccess,
            action = "Open settings",
            onClick = { openSafely(context, Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) },
            secondaryAction = "App info",
            onSecondary = { openAppInfo(context) },
            hint = "Sideloaded on Android 13+? If the switch is greyed out: App info → ⋮ → Allow restricted settings.",
        )
        PermissionCard(
            icon = Icons.Filled.Phone,
            title = "Phone, call log & contacts",
            body = "Detects incoming calls, the caller's number and their contact name.",
            granted = phone,
            action = "Allow",
            onClick = { launcher.launch(Permissions.PHONE) },
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionCard(
                icon = Icons.Filled.Warning,
                title = "Post notifications",
                body = "Shows the \"Pixie is connected\" status and call-back prompts.",
                granted = post,
                action = "Allow",
                onClick = { launcher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) },
            )
        }
        PermissionCard(
            icon = Icons.Filled.LocationOn,
            title = "Location for weather",
            body = "Lets Pixie know the local weather. Sent rounded to about 1 km, only while Pixie is linked; " +
                "\"Approximate\" is enough.",
            granted = location,
            action = "Allow",
            onClick = { locationLauncher.launch(Permissions.LOCATION) },
            secondaryAction = "App info",
            onSecondary = { openAppInfo(context) },
            hint = "Denied twice? Android stops asking: App info → Permissions → Location → Allow only while using the app.",
        )
        PermissionCard(
            icon = Icons.Filled.Settings,
            title = "Run in background",
            body = "Exempts Pixie from battery optimisation so the link stays up.",
            granted = battery,
            action = "Allow",
            onClick = { requestBatteryExemption(context) },
        )
    }
}

@Composable
private fun PermissionCard(
    icon: ImageVector,
    title: String,
    body: String,
    granted: Boolean,
    action: String,
    onClick: () -> Unit,
    secondaryAction: String? = null,
    onSecondary: (() -> Unit)? = null,
    hint: String? = null,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                if (granted) {
                    Icon(Icons.Filled.CheckCircle, contentDescription = "Granted", tint = PixieGreen)
                } else {
                    Icon(Icons.Filled.Warning, contentDescription = "Needed", tint = PixieAmber)
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!granted) {
                if (hint != null) {
                    Spacer(Modifier.height(6.dp))
                    Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = onClick) { Text(action) }
                    if (secondaryAction != null && onSecondary != null) {
                        TextButton(onClick = onSecondary) { Text(secondaryAction) }
                    }
                }
            }
        }
    }
}

@Composable
private fun PrivacyNote() {
    Text(
        "Pixie only reads notification previews — never your chat history — and only sends a reply after you " +
            "approve it on one of your devices.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 12.dp, start = 4.dp, end = 4.dp),
    )
}

// ---- Intents --------------------------------------------------------------------------------------------------

private fun openSafely(context: Context, intent: Intent): Boolean {
    return try {
        context.startActivity(intent)
        true
    } catch (e: Exception) {
        false
    }
}

private fun openAppInfo(context: Context) {
    openSafely(
        context,
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
    )
}

@SuppressLint("BatteryLife")
private fun requestBatteryExemption(context: Context) {
    val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + context.packageName))
    if (!openSafely(context, direct)) {
        openSafely(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
}

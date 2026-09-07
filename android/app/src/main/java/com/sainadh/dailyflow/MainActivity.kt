package com.sainadh.dailyflow

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.FirebaseException
import com.google.firebase.auth.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repository = (application as DailyFlowApplication).repository
        setContent { DailyFlowApp(repository, this) }
    }
    override fun onStart() {
        super.onStart()
        if (DeviceTimer.state.value.running) androidx.core.content.ContextCompat.startForegroundService(this, android.content.Intent(this, TimerService::class.java).setAction("START"))
    }
    fun requestNotifications() { if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DailyFlowApp(repository: AppRepository, activity: MainActivity) {
    val dark = repository.settings.optBoolean("dark")
    val accent = runCatching { Color(android.graphics.Color.parseColor(repository.settings.optString("accentColor", "#7C3AED"))) }.getOrDefault(Color(0xFF7254D3))
    val baseScheme = if (dark) darkColorScheme(primary = accent, background = Color(0xFF17151C), surface = Color(0xFF211F27)) else lightColorScheme(primary = accent, background = Color(0xFFFAF9FC), surface = Color.White)
    val warmth = repository.settings.optInt("warmLight", 0).coerceIn(0, 100) / 100f * 0.18f
    val scheme = baseScheme.copy(background = androidx.compose.ui.graphics.lerp(baseScheme.background, Color(0xFFFFCB80), warmth), surface = androidx.compose.ui.graphics.lerp(baseScheme.surface, Color(0xFFFFCB80), warmth))
    var screen by remember { mutableIntStateOf(0) }
    var showAccount by remember { mutableStateOf(false) }
    var showProfiles by remember { mutableStateOf(false) }
    var profileName by remember { mutableStateOf("") }
    val systemDensity = LocalDensity.current
    CompositionLocalProvider(LocalDensity provides Density(systemDensity.density, systemDensity.fontScale * repository.settings.optInt("fontSize", 16).coerceIn(12, 24) / 16f)) {
    MaterialTheme(colorScheme = scheme) {
        Surface(Modifier.fillMaxSize()) {
            if (!repository.ready) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            else if (screen == 1 && repository.settings.optBoolean("focusMode")) Box(Modifier.systemBarsPadding()) { FocusScreen(repository, activity) }
            else Scaffold(
                topBar = { TopAppBar(title = {
                    Column { Text("DailyFlow", fontWeight = FontWeight.Bold); Text(repository.profiles.find { it.optString("id") == repository.activeProfileId }?.let { "${it.optString("emoji")} ${it.optString("name")}" } ?: "Your personal workspace", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }, actions = {
                    IconButton(onClick = { showProfiles = true }) { Icon(Icons.Default.Workspaces, "Switch profile") }
                    IconButton(onClick = { showAccount = true }) { Icon(Icons.Default.AccountCircle, "Account") }
                }) },
                bottomBar = { NavigationBar {
                    listOf("Log", "Focus", "Insights", "Settings").forEachIndexed { index, label ->
                        val icon = when(index) { 0 -> Icons.AutoMirrored.Filled.List; 1 -> Icons.Default.Timer; 2 -> Icons.Default.Insights; else -> Icons.Default.Tune }
                        NavigationBarItem(selected = screen == index, onClick = { screen = index }, icon = { Icon(icon, label) }, label = { Text(label) })
                    }
                } }
            ) { padding ->
                Column(Modifier.fillMaxSize().padding(padding)) {
                    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerLow).clickable { repository.retrySync() }.padding(horizontal = 20.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).background(if (repository.conflicts.isEmpty()) Color(0xFF3AA787) else Color(0xFFD69B30), RoundedCornerShape(50)))
                        Spacer(Modifier.width(8.dp)); Text(repository.syncStatus, style = MaterialTheme.typography.labelSmall)
                        if (repository.owner == "guest") { Spacer(Modifier.weight(1f)); Text("Connect account", color = accent, fontSize = 11.sp, modifier = Modifier.clickable { showAccount = true }) }
                    }
                    when (screen) {
                        0 -> TasksScreen(repository, onFocus = { date, task ->
                            DeviceTimer.configure(repository.activeProfileId, task.optString("id"), date, seconds = repository.settings.optLong("workDuration", 25) * 60, label = task.optString("content"))
                            screen = 1
                        })
                        1 -> FocusScreen(repository, activity)
                        2 -> InsightsScreen(repository)
                        3 -> SettingsScreen(repository, activity)
                    }
                }
            }
        }
        NextDayRecap(repository, activity)
        repository.error?.let { message -> AlertDialog(onDismissRequest = { repository.error = null }, title = { Text("DailyFlow") }, text = { Text(message) }, confirmButton = { TextButton(onClick = { repository.error = null }) { Text("OK") } }) }
        if (showAccount) ModalBottomSheet(onDismissRequest = { showAccount = false }) {
            AccountScreen(repository, activity) { showAccount = false }
        }
        if (showProfiles) AlertDialog(onDismissRequest = { showProfiles = false }, title = { Text("Your workspaces") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                repository.profiles.forEachIndexed { index, p ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton(onClick = { repository.selectProfile(p.getString("id")); showProfiles = false }, modifier = Modifier.weight(1f)) { Text("${p.optString("emoji")}  ${p.optString("name")}") }
                        IconButton(enabled = index > 0, onClick = { repository.mutateMeta { meta -> val profiles = meta.arr("profiles").objects().toMutableList(); val moved = profiles.removeAt(index); profiles.add(index - 1, moved); meta.put("profiles", org.json.JSONArray(profiles)) } }) { Icon(Icons.Default.ArrowUpward, "Move workspace up") }
                    }
                }
                OutlinedTextField(profileName, { profileName = it }, label = { Text("New workspace name") }, singleLine = true)
            }
        }, confirmButton = { TextButton(enabled = profileName.isNotBlank(), onClick = { repository.addProfile(profileName); profileName = ""; showProfiles = false }) { Text("Create") } }, dismissButton = { TextButton(onClick = { showProfiles = false }) { Text("Close") } })
    }
    }
}

@Composable
fun AccountScreen(repository: AppRepository, activity: MainActivity, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }; var password by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }; var code by remember { mutableStateOf("") }; var verification by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }; var message by remember { mutableStateOf("") }; var signUp by remember { mutableStateOf(false) }
    val auth = repository.auth
    fun execute(block: suspend () -> Unit) { scope.launch { busy = true; message = ""; try { block() } catch (e: Exception) { message = e.localizedMessage ?: "Sign in failed. Please try again." }; busy = false } }
    Column(Modifier.fillMaxWidth().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(if (auth?.currentUser != null) "Your account" else "Your flow, everywhere", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        if (auth?.currentUser != null) {
            Text(auth.currentUser?.email ?: auth.currentUser?.phoneNumber ?: "Signed in")
            Text("Your tasks, notes and focus history sync across your devices. Running timers stay on the device where you start them.")
            OutlinedButton(onClick = { repository.signOut(); close() }) { Text("Sign out") }
        } else if (auth == null) {
            Text("Account services are not configured in this build. You can continue using the local workspace.")
        } else {
            Text("Sign in to securely sync your workspaces.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Your guest workspace stays on this device. Export it first, then import into a signed-in workspace if you want to move those activities to your account.", style = MaterialTheme.typography.bodySmall)
            Button(enabled = !busy, onClick = { execute {
                val resource = activity.resources.getIdentifier("default_web_client_id", "string", activity.packageName)
                check(resource != 0) { "Google sign-in needs the Android OAuth client configuration." }
                val option = GetGoogleIdOption.Builder().setServerClientId(activity.getString(resource)).setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build()
                val credential = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(option).build()).credential
                val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
                auth.signInWithCredential(GoogleAuthProvider.getCredential(token, null)).await(); close()
            } }, modifier = Modifier.fillMaxWidth()) { Text("Continue with Google") }
            HorizontalDivider()
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
            Button(enabled = !busy && email.isNotBlank() && password.isNotBlank(), onClick = { execute {
                if (signUp) auth.createUserWithEmailAndPassword(email.trim(), password).await() else auth.signInWithEmailAndPassword(email.trim(), password).await()
                close()
            } }, modifier = Modifier.fillMaxWidth()) { Text(if (signUp) "Create account" else "Sign in with email") }
            Row { TextButton(onClick = { signUp = !signUp }) { Text(if (signUp) "Already have an account?" else "Create an account") }; TextButton(onClick = { execute { auth.sendPasswordResetEmail(email.trim()).await(); message = "Password reset email sent." } }, enabled = email.isNotBlank() && !busy) { Text("Reset password") } }
            HorizontalDivider()
            Text("Phone sign-in", fontWeight = FontWeight.SemiBold)
            Text("An SMS verification code will be sent to your number. Standard message rates may apply.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(phone, { phone = it }, label = { Text("Phone with country code") }, placeholder = { Text("+91…") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedButton(enabled = !busy && phone.startsWith("+"), onClick = {
                busy = true
                PhoneAuthProvider.verifyPhoneNumber(PhoneAuthOptions.newBuilder(auth).setPhoneNumber(phone.trim()).setTimeout(60L, TimeUnit.SECONDS).setActivity(activity)
                    .setCallbacks(object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
                        override fun onVerificationCompleted(credential: PhoneAuthCredential) { execute { auth.signInWithCredential(credential).await(); close() } }
                        override fun onVerificationFailed(e: FirebaseException) { busy = false; message = e.localizedMessage ?: "Phone verification failed." }
                        override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) { verification = id; busy = false; message = "Verification code sent." }
                    }).build())
            }) { Text("Send verification code") }
            if (verification.isNotEmpty()) {
                OutlinedTextField(code, { code = it }, label = { Text("SMS verification code") }, singleLine = true)
                Button(enabled = !busy && code.length >= 6, onClick = { execute { auth.signInWithCredential(PhoneAuthProvider.getCredential(verification, code)).await(); close() } }) { Text("Verify and sign in") }
            }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (message.isNotEmpty()) Text(message, color = MaterialTheme.colorScheme.error)
        Spacer(Modifier.height(24.dp))
    }
}

// bma_tts.cc — in-process Tolk caller for the Blackmoon Prophecy accessibility mod.
//
// A tiny N-API addon that dynamically loads the user-deployed Tolk.dll and exposes
// load / detect / speak / silence / isSpeaking / unload to JavaScript. Built once with
// nw-gyp against NW.js 0.49.2's ABI; N-API keeps the compiled .node ABI-stable.
//
// No link-time dependency on Tolk: we LoadLibrary it at runtime by absolute path so the
// game works with or without the DLL present (the JS side falls back to Web Speech).
//
// Threading: Tolk_Output is a blocking call — an LRPC round-trip into the NVDA process, or
// a SAPI call that needs COM apartment affinity — so calling it from JS stalls the game's
// render thread mid-frame. Everything Tolk-related therefore lives on ONE dedicated worker
// thread that this addon owns: it CoInitializes itself, calls Tolk_Load, and then drains a
// queue. speak() just enqueues and returns, so the JS side never blocks. Keeping *all*
// Tolk_* calls on that single thread is what makes the SAPI path safe.

#include <windows.h>
#include <node_api.h>
#include <string>
#include <vector>
#include <deque>
#include <thread>
#include <mutex>
#include <condition_variable>

// ---- Tolk export signatures (all __cdecl, wide strings) ----
typedef void          (__cdecl *Tolk_Load_t)();
typedef void          (__cdecl *Tolk_Unload_t)();
typedef bool          (__cdecl *Tolk_IsLoaded_t)();
typedef void          (__cdecl *Tolk_TrySAPI_t)(bool);
typedef const wchar_t*(__cdecl *Tolk_DetectScreenReader_t)();
typedef bool          (__cdecl *Tolk_HasSpeech_t)();
typedef bool          (__cdecl *Tolk_Output_t)(const wchar_t*, bool);
typedef bool          (__cdecl *Tolk_Silence_t)();
typedef bool          (__cdecl *Tolk_IsSpeaking_t)();

static HMODULE g_dll = NULL;
static Tolk_Load_t               p_Load = NULL;
static Tolk_Unload_t             p_Unload = NULL;
static Tolk_IsLoaded_t           p_IsLoaded = NULL;
static Tolk_TrySAPI_t            p_TrySAPI = NULL;
static Tolk_DetectScreenReader_t p_Detect = NULL;
static Tolk_HasSpeech_t          p_HasSpeech = NULL;
static Tolk_Output_t             p_Output = NULL;
static Tolk_Silence_t            p_Silence = NULL;
static Tolk_IsSpeaking_t         p_IsSpeaking = NULL;

// ---- speech worker ----
// Only WorkerMain() may touch p_* after Load() hands off. Everything below g_mutex is
// shared with the JS thread; the JS thread never blocks on Tolk itself, only on this lock.
struct Utterance { std::wstring text; bool interrupt; };

static std::thread              g_thread;
static std::mutex               g_mutex;
static std::condition_variable  g_cv;        // wakes the worker
static std::condition_variable  g_cvReady;   // wakes Load() once init finished
static std::deque<Utterance>    g_queue;
static bool         g_started   = false;     // g_thread is joinable
static bool         g_running   = false;     // worker should keep looping
static bool         g_initDone  = false;
static bool         g_initOk    = false;
static bool         g_cancel    = false;     // a Tolk_Silence is pending
static bool         g_speaking  = false;     // last value the worker observed
static bool         g_hasSpeech = false;     // cached at init
static std::wstring g_reader;                // cached Tolk_DetectScreenReader

// A screen reader that falls behind must never let the queue grow without bound; an
// interrupting utterance replaces everything pending anyway, which is the common case.
static const size_t kMaxQueue = 64;

static void WorkerMain() {
  // Tolk's SAPI backend creates COM objects, so the apartment must belong to this thread —
  // that is the reason Tolk_Load runs here rather than on the thread that called load().
  HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

  if (p_TrySAPI) p_TrySAPI(true);   // speech even with no screen reader running
  if (p_Load) p_Load();
  bool ok = p_IsLoaded ? p_IsLoaded() : true;

  {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (ok) {
      if (p_Detect) { const wchar_t* n = p_Detect(); if (n) g_reader.assign(n); }
      if (p_HasSpeech) g_hasSpeech = p_HasSpeech();
    }
    g_initOk = ok;
    g_initDone = true;
  }
  g_cvReady.notify_all();

  for (;;) {
    Utterance u;
    bool haveWork = false, doCancel = false, quit = false;
    {
      std::unique_lock<std::mutex> lk(g_mutex);
      g_cv.wait(lk, [] { return !g_running || g_cancel || !g_queue.empty(); });
      if (g_cancel) { g_cancel = false; doCancel = true; }
      if (!g_queue.empty()) { u = g_queue.front(); g_queue.pop_front(); haveWork = true; }
      else if (!g_running) { quit = true; }
    }
    if (doCancel && p_Silence) p_Silence();
    if (haveWork && p_Output) {
      p_Output(u.text.c_str(), u.interrupt);
      bool s = p_IsSpeaking ? p_IsSpeaking() : false;
      std::lock_guard<std::mutex> lk(g_mutex);
      g_speaking = s;
    }
    if (quit) break;
  }

  if (p_Unload) p_Unload();
  if (SUCCEEDED(hr)) CoUninitialize();
}

// Stop and join the worker. Safe to call repeatedly and from the env cleanup hook.
static void StopWorker() {
  if (!g_started) return;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    g_running = false;
    g_queue.clear();          // drop anything still pending; we are shutting down
  }
  g_cv.notify_all();
  if (g_thread.joinable()) g_thread.join();
  g_started = false;
}

static void TeardownAll() {
  StopWorker();               // worker calls Tolk_Unload + CoUninitialize on its way out
  if (g_dll) {
    FreeLibrary(g_dll);
    g_dll = NULL;
    p_Load = NULL; p_Unload = NULL; p_IsLoaded = NULL; p_TrySAPI = NULL;
    p_Detect = NULL; p_HasSpeech = NULL; p_Output = NULL; p_Silence = NULL; p_IsSpeaking = NULL;
  }
  std::lock_guard<std::mutex> lk(g_mutex);
  g_initDone = false; g_initOk = false; g_speaking = false; g_hasSpeech = false;
  g_reader.clear();
}

static void CleanupHook(void*) { TeardownAll(); }

// ---- helpers ----
static napi_value Bool(napi_env env, bool v) {
  napi_value out; napi_get_boolean(env, v, &out); return out;
}

// Read a JS string argument as UTF-16 (wchar_t on Windows). Returns false on failure.
static bool ArgToWide(napi_env env, napi_value arg, std::wstring &out) {
  size_t len = 0;
  if (napi_get_value_string_utf16(env, arg, NULL, 0, &len) != napi_ok) return false;
  std::vector<char16_t> buf(len + 1, 0);
  size_t written = 0;
  if (napi_get_value_string_utf16(env, arg, buf.data(), buf.size(), &written) != napi_ok) return false;
  out.assign(reinterpret_cast<wchar_t*>(buf.data()), written);
  return true;
}

// load(dir) : bool — LoadLibrary(dir\Tolk.dll), resolve exports, then hand Tolk to the worker.
static napi_value Load(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return Bool(env, false);

  std::wstring dir;
  if (!ArgToWide(env, argv[0], dir)) return Bool(env, false);

  if (g_dll) {                                     // already loaded
    std::lock_guard<std::mutex> lk(g_mutex);
    return Bool(env, g_started && g_initOk);
  }

  std::wstring path = dir;
  if (!path.empty() && path.back() != L'\\' && path.back() != L'/') path += L'\\';
  path += L"Tolk.dll";

  // Absolute path means cwd is irrelevant; Tolk.dll pulls in nvdaControllerClient64.dll
  // from the same directory, so add it to the DLL search path.
  SetDllDirectoryW(dir.c_str());
  g_dll = LoadLibraryW(path.c_str());
  if (!g_dll) return Bool(env, false);

  p_Load       = (Tolk_Load_t)               GetProcAddress(g_dll, "Tolk_Load");
  p_Unload     = (Tolk_Unload_t)             GetProcAddress(g_dll, "Tolk_Unload");
  p_IsLoaded   = (Tolk_IsLoaded_t)           GetProcAddress(g_dll, "Tolk_IsLoaded");
  p_TrySAPI    = (Tolk_TrySAPI_t)            GetProcAddress(g_dll, "Tolk_TrySAPI");
  p_Detect     = (Tolk_DetectScreenReader_t) GetProcAddress(g_dll, "Tolk_DetectScreenReader");
  p_HasSpeech  = (Tolk_HasSpeech_t)          GetProcAddress(g_dll, "Tolk_HasSpeech");
  p_Output     = (Tolk_Output_t)             GetProcAddress(g_dll, "Tolk_Output");
  p_Silence    = (Tolk_Silence_t)            GetProcAddress(g_dll, "Tolk_Silence");
  p_IsSpeaking = (Tolk_IsSpeaking_t)         GetProcAddress(g_dll, "Tolk_IsSpeaking");

  if (!p_Load || !p_Output) {  // minimum needed to function
    FreeLibrary(g_dll); g_dll = NULL;
    return Bool(env, false);
  }

  {
    std::lock_guard<std::mutex> lk(g_mutex);
    g_running = true; g_initDone = false; g_initOk = false; g_cancel = false;
    g_speaking = false; g_hasSpeech = false;
    g_queue.clear(); g_reader.clear();
  }
  g_thread = std::thread(WorkerMain);
  g_started = true;

  // Wait for Tolk_Load to finish so this call still returns a meaningful bool. The wait is
  // unbounded on purpose: it is exactly the ~20 ms this used to spend inline, and bounding it
  // would mean either abandoning a live thread or joining one still inside Tolk_Load.
  bool ok;
  {
    std::unique_lock<std::mutex> lk(g_mutex);
    g_cvReady.wait(lk, [] { return g_initDone; });
    ok = g_initOk;
  }
  if (!ok) {                                       // Tolk present but unusable — clean up fully
    TeardownAll();
    return Bool(env, false);
  }
  return Bool(env, true);
}

// detect() : string | null — the name the worker cached during init.
static napi_value Detect(napi_env env, napi_callback_info info) {
  napi_value nul; napi_get_null(env, &nul);
  std::wstring reader;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    reader = g_reader;
  }
  if (reader.empty()) return nul;
  napi_value out;
  if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(reader.c_str()),
                               NAPI_AUTO_LENGTH, &out) != napi_ok) return nul;
  return out;
}

// speak(text, interrupt) : bool — enqueue and return; never touches Tolk.
static napi_value Speak(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!g_started || argc < 1) return Bool(env, false);

  std::wstring text;
  if (!ArgToWide(env, argv[0], text)) return Bool(env, false);

  bool interrupt = false;
  if (argc >= 2) napi_get_value_bool(env, argv[1], &interrupt);

  bool queued = false;
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (g_running) {
      // An interrupting utterance supersedes everything still waiting, so drop the backlog
      // rather than letting it play out behind the new line.
      if (interrupt) g_queue.clear();
      g_queue.push_back(Utterance{ text, interrupt });
      while (g_queue.size() > kMaxQueue) g_queue.pop_front();
      queued = true;
    }
  }
  if (queued) g_cv.notify_one();
  return Bool(env, queued);
}

static napi_value Silence(napi_env env, napi_callback_info info) {
  if (!g_started) return Bool(env, false);
  {
    std::lock_guard<std::mutex> lk(g_mutex);
    g_queue.clear();
    g_cancel = true;
    g_speaking = false;
  }
  g_cv.notify_one();
  return Bool(env, true);
}

// Reports the worker's last observed state, plus anything still queued. Approximate by
// design — polling Tolk synchronously here would reintroduce the stall this file removes.
static napi_value IsSpeaking(napi_env env, napi_callback_info info) {
  std::lock_guard<std::mutex> lk(g_mutex);
  return Bool(env, g_speaking || !g_queue.empty());
}

static napi_value HasSpeech(napi_env env, napi_callback_info info) {
  std::lock_guard<std::mutex> lk(g_mutex);
  return Bool(env, g_hasSpeech);
}

static napi_value Unload(napi_env env, napi_callback_info info) {
  TeardownAll();
  napi_value undef; napi_get_undefined(env, &undef); return undef;
}

static void Export(napi_env env, napi_value exports, const char* name, napi_callback fn) {
  napi_value f;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &f);
  napi_set_named_property(env, exports, name, f);
}

static napi_value Init(napi_env env, napi_value exports) {
  Export(env, exports, "load", Load);
  Export(env, exports, "detect", Detect);
  Export(env, exports, "speak", Speak);
  Export(env, exports, "silence", Silence);
  Export(env, exports, "isSpeaking", IsSpeaking);
  Export(env, exports, "hasSpeech", HasSpeech);
  Export(env, exports, "unload", Unload);
  // An NW.js page reload tears the env down without calling unload(); without this the
  // worker thread would outlive its environment.
  napi_add_env_cleanup_hook(env, CleanupHook, NULL);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

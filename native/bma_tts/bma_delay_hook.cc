/*
 * Custom delay-load hook for NW.js.
 *
 * node-gyp's stock win_delay_load_hook.cc redirects the module's delay-loaded
 * "node.exe" imports (the N-API symbols) to libnode.dll or the host executable.
 * Under NW.js the host exe is Game.exe, which does NOT export N-API — so the
 * addon segfaults on its first napi_* call during require().
 *
 * NW.js exports all napi_* symbols from node.dll, so we resolve there first.
 * This lets a modern node-gyp build load correctly inside NW.js.
 */

#ifdef _MSC_VER

#pragma managed(push, off)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo* info) {
  HMODULE m;
  if (event != dliNotePreLoadLibrary)
    return NULL;

  // Only intercept the host-binary delay import (node.exe). Hardcoded rather than
  // node-gyp's HOST_BINARY define, since we disable the stock hook that defines it.
  if (_stricmp(info->szDll, "node.exe") != 0)
    return NULL;

  // NW.js: N-API lives in node.dll. Fall back to libnode.dll, then the host exe.
  m = GetModuleHandle(TEXT("node.dll"));
  if (m == NULL) m = GetModuleHandle(TEXT("libnode.dll"));
  if (m == NULL) m = GetModuleHandle(NULL);
  return (FARPROC) m;
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = load_exe_hook;

#pragma managed(pop)

#endif

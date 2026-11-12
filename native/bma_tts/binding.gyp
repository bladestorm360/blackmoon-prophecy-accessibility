{
  "targets": [
    {
      "target_name": "bma_tts",
      "sources": [ "bma_tts.cc", "bma_delay_hook.cc" ],
      "defines": [ "UNICODE", "_UNICODE", "NAPI_VERSION=7" ],
      "win_delay_load_hook": "false",
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        },
        "VCLinkerTool": {
          "DelayLoadDLLs": [ "node.exe" ],
          "AdditionalDependencies": [ "delayimp.lib" ]
        }
      },
      "libraries": [ "-lkernel32.lib", "-luser32.lib" ]
    }
  ]
}

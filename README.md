# antumi-wsl-check

Runs `wsl-check.ps1` on a GitHub Windows runner with WSL 2, to check what
[Antumi](https://github.com/flyhero/antumi)'s planned WSL support assumes about WSL: whether a
Linux process started through a detached `wsl.exe` outlives what started it, and which way
`127.0.0.1` is reachable between Windows and the distro.

A scratch repository; nothing here is part of Antumi.

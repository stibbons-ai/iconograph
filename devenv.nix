{ pkgs, ... }:

{
  packages = [
    pkgs.git
    pkgs.bun
  ];

  env = {
    MASTRA_TELEMETRY_DISABLED = "1";
    DO_NOT_TRACK = "1";
  };

  tasks."iconograph:install" = {
    exec = "bun install --frozen-lockfile";
    before = [ "devenv:enterShell" ];
  };
}

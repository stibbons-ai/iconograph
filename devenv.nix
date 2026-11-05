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

  tasks."iconograph:hooks" = {
    exec = "bun run hooks:install";
    after = [ "iconograph:install" ];
    before = [ "devenv:enterShell" ];
  };

  # Vendor keys for live Runs (secretspec.toml, README "Vendor keys"), exported into the live
  # shell only. Never via `env`: that would write them into the world-readable Nix store.
  enterShell = ''
    if secretspec_exports="$(secretspec export --format shell --reason "devenv shell: iconograph vendor keys for live Runs")"; then
      eval "$secretspec_exports"
    else
      echo "secretspec: vendor keys not loaded; live Runs will name the missing key" >&2
    fi
    unset secretspec_exports
  '';
}

import { fixtureModeEnabled } from "./fixture.js";

export function redriveEnabled(): boolean {
  if (fixtureModeEnabled()) return false;
  const raw = (process.env.SFN_LENS_ALLOW_REDRIVE ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function serverCapabilities() {
  return {
    redriveEnabled: redriveEnabled(),
    fixtureMode: fixtureModeEnabled(),
  };
}

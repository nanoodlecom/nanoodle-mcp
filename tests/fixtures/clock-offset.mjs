// Explicit Node --import hook used only by the offline simulator. Advance the
// child and fake chain together when testing expiry; keep real timer durations.
import { readFileSync } from "node:fs";
const systemNow = Date.now;
Date.now = () => {
  const offset = JSON.parse(readFileSync(process.env.NANOODLE_TEST_CLOCK_FILE, "utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 86_400_000) throw Error("Invalid simulation clock");
  return systemNow() + offset;
};

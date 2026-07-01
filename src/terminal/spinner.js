const frames = ["-", "\\", "|", "/"];
import { paint } from "./theme.js";

export function createSpinner(label) {
  let timer;
  let index = 0;
  let active = false;

  return {
    start() {
      if (active || !process.stdout.isTTY) return;
      active = true;
      process.stdout.write("\x1B[?25l");
      timer = setInterval(() => {
        process.stdout.write(`\r${paint("title", frames[index % frames.length])} ${label}`);
        index += 1;
      }, 100);
    },
    stop(message) {
      if (!active) return;
      active = false;
      clearInterval(timer);
      process.stdout.write("\r\x1B[2K\x1B[?25h");
      if (message) process.stdout.write(`${message}\n`);
    },
  };
}

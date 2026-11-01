import readline from "node:readline";
const report = (state) =>
  process.stdout.write(`\u001b]7501;state=${state}:app=fixture\u001b\\`);
console.log("Fixture ready");
report("idle");
let waiting = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  report("working");
  if (line.includes("ask") && !waiting) {
    waiting = true;
    console.log("Which label should I use?");
    report("blocked");
  } else {
    console.log("Fixture result: " + line);
    waiting = false;
    report("idle");
  }
});

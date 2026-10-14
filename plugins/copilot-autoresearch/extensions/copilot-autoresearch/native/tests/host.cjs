const fs = require("node:fs");

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const addon = require(spec.addon);

let run;

function receipt(file, value) {
  fs.writeFileSync(`${file}.writing`, JSON.stringify(value));
  fs.renameSync(`${file}.writing`, file);
}

try {
  run = addon.create(spec.launch);
  receipt(spec.hostReceipt, { hostPid: process.pid, ...run.snapshot() });
  run.resume();
  let reported = false;

  const timer = setInterval(() => {
    if (!reported && fs.existsSync(spec.ready)) {
      const markerParent = Number(fs.readFileSync(spec.parent, "utf8"));
      const readyGrandchild = Number(fs.readFileSync(spec.ready, "utf8"));
      receipt(spec.membership, {
        ...run.snapshot(),
        markerParent,
        readyGrandchild,
        parentMember: run.contains(markerParent),
        grandchildMember: run.contains(readyGrandchild),
      });
      reported = true;
    }

    if (fs.existsSync(spec.stop)) {
      const stopped = run.stop();
      receipt(spec.stopped, stopped);
      run.dispose();
      clearInterval(timer);
      process.exitCode = 0;
    }
  }, 5);

  setTimeout(() => {
    run.stop();
    run.dispose();
    process.exit(2);
  }, 15_000).unref();
} catch (error) {
  console.error(JSON.stringify({ stage: error.stage, win32Code: error.win32Code, nodeApiStatus: error.nodeApiStatus }));
  process.exitCode = 1;
}

import assert from "node:assert/strict";

// Pinned NUC 0.3.1 source-admitted arenas and generated-program lifetimes.
export function createSuite() {
  const recursion = (n, fail = false) =>
    `sub descend(n as u8) fails\nvar local as u8 = n + 65\nwriteOutputByte(local) else fail\nif n > 0\ndescend(n - 1) else fail\nend\n${fail ? "fail 7" : "writeOutputByte(local) else fail"}\nend\nsub main() fails\ndescend(${n}) else fail\nwriteOutputByte(33) else fail\nend\n`;
  const writable = (n) =>
    `var data as u8[${n}]\nsub main() fails\ndata[0] = 65\ndata[${n - 1}] = 90\nwriteOutputByte(data[0]) else fail\nwriteOutputByte(data[${n - 1}]) else fail\nend\n`;
  const code = (n) =>
    Array.from(
      { length: Math.ceil(n / 50) },
      (_, i) =>
        `sub p${i}()\nvar x as u8 = 0\n${"x = x + 1\n".repeat(Math.min(50, n - i * 50))}end\n`,
    ).join("") + `sub main() fails\nwriteOutputByte(75) else fail\nend\n`;
  const ro = (n) =>
    `const data as u8[${n}] = [${Array.from({ length: n }, (_, i) => (i === 0 ? 65 : i === n - 1 ? 90 : 0)).join(",")}]\nsub main() fails\nwriteOutputByte(data[0]) else fail\nwriteOutputByte(data[${n - 1}]) else fail\nend\n`;
  const combined = `var first as u8[1024] = [${Array(1024).fill(0).join(",")}]\nvar second as u8[1024]\nsub main() fails\nfirst[0] = 65\nfirst[1023] = 66\nsecond[0] = 89\nsecond[1023] = 90\nwriteOutputByte(first[0]) else fail\nwriteOutputByte(first[1023]) else fail\nwriteOutputByte(second[0]) else fail\nwriteOutputByte(second[1023]) else fail\nend\n`;
  const src = {
    R7: recursion(7),
    R8: recursion(8),
    F7: recursion(7, true),
    W1024: writable(1024),
    W1025: writable(1025),
    W2048: combined,
    W2049: combined.replace("sub main()", "var overflow as u8\nsub main()"),
    C58: code(58),
    C59: code(59),
    RO1024: ro(1024),
    RO1025: ro(1025),
    RONEXT: ro(1024).replace(
      "sub main()",
      "const extra as u8[1] = [0]\nsub main()",
    ),
  };
  const fixtures = new Map(
    Object.entries(src).map(([name, source]) => [
      name + ".NU",
      Buffer.from(source),
    ]),
  );
  fixtures.set("END.TXT", Buffer.from("AB-LIMITS-END"));
  const diagnostics = {
    W1025: "51 P=01 O=0013 L=0001 C=0015",
    W2049: "51 P=01 O=0843 L=0003 C=0013",
    C59: "28 P=01 O=02BA L=0044 C=0004",
    RO1025: "51 P=01 O=0015 L=0001 C=0018",
    RONEXT: "5D P=01 O=0823 L=0002 C=0007",
  };
  const outcome = {
    R7: "HGFEDCBAABCDEFGH!",
    R8: "IHGFEDCB\r\nNucleus trap\r\n",
    F7: "HGFEDCBA\r\nUnhandled Nucleus failure\r\n",
    W1024: "AZ",
    W2048: "ABYZ",
    C58: "K",
    RO1024: "AZ",
  };
  const generated = new Set(Object.keys(outcome).map((n) => n + ".COM"));
  const saved = new Map();
  const generatedSnapshots = new WeakMap();
  const cmd = (id, text, tool, required, check) => ({
    id,
    input: text + "\r",
    suffix: "\r\nB>",
    tool,
    required,
    check,
    checkOutput(bytes) {
      if (tool === "NUC.COM")
        assert.equal(
          Buffer.from(bytes).toString("latin1"),
          text +
            "\r\r\n" +
            (required ? "\r\n" + required + "\r\n" : "") +
            "\r\nB>",
        );
      else if (generated.has(tool))
        assert.equal(
          Buffer.from(bytes).toString("latin1"),
          text + "\r\r\n" + outcome[tool.slice(0, -4)] + "\r\nB>",
        );
    },
  });
  const steps = [
    { id: "boot", input: "", suffix: "\r\nA>" },
    cmd("select-b", "B:"),
  ];
  const run = (name, id = "run-" + name) =>
    cmd(id, name, name + ".COM", "\r\n" + outcome[name] + "\r\nB>");
  for (const name of Object.keys(src)) {
    steps.push(
      cmd(
        "compile-" + name,
        `NUC ${name}.NU ${name}.COM`,
        "NUC.COM",
        diagnostics[name] ? "Nucleus error " + diagnostics[name] : undefined,
        (disk) => {
          if (diagnostics[name])
            assert(!disk.file_names().includes(name + ".COM"));
          else {
            const bytes = Buffer.from(disk.read_file(name + ".COM"));
            assert(bytes.length > 2048);
            saved.set(name, bytes);
          }
        },
      ),
    );
    if (outcome[name]) steps.push(run(name));
  }
  for (const [bad, keep] of [
    ["W1025", "W1024"],
    ["W2049", "W2048"],
    ["C59", "C58"],
    ["RO1025", "RO1024"],
    ["RONEXT", "RO1024"],
  ]) {
    steps.push(
      cmd(
        "preserve-" + bad,
        `NUC ${bad}.NU ${keep}.COM`,
        "NUC.COM",
        "Nucleus error " + diagnostics[bad],
        (disk) =>
          assert.deepEqual(
            Buffer.from(disk.read_file(keep + ".COM")),
            saved.get(keep),
          ),
      ),
    );
    steps.push(run(keep, "reopen-" + bad));
  }
  steps.push(
    cmd("following-command", "TYPE END.TXT", undefined, "AB-LIMITS-END"),
  );
  const limits = [
    "Pinned NUC 0.3.1 admits 1,024 bytes per aggregate and per initialized/BSS segment; this suite proves combined 2,048 bytes and safe next-byte rejection, not the theoretical 3,251 usable writable bytes or 23,808 candidate bytes.",
    "The 58/59 assignment pair proves the earlier semantic-transcript admission limit for this source shape, not the 0x5800 generated-code ceiling; the transcript is bounded by 512 bytes and 255 operations, with a shared capacity diagnostic.",
    "Read-only 1,024 bytes and next-object rejection are proved; exhaustive compiler semantics, browser and ESP32 execution are outside this suite.",
  ];
  return {
    fixtures,
    steps,
    outputStems: Object.keys(src),
    mutableFiles: new Set(),
    limits,
    // Call once per observed instruction while lifetime is active, before the
    // common engine consumes PC 0/RET. State is plain {pc,sp}; never retain WASM objects.
    observe(cpu, state, lifetime) {
      if (!lifetime || !generated.has(lifetime.tool)) return;
      const { pc, sp } = state;
      if (pc === 0x100) {
        // The provider prefix contains writable FCBs; generated code/runtime
        // and read-only bytes begin at 0x0800. Copy only at entry and return.
        generatedSnapshots.set(lifetime, {
          code: Buffer.from(cpu.read_ram(0x800, 0x5000)),
          afterWritable: cpu.read_ram(0x604d, 1)[0],
        });
      }
      if (pc >= 0x100 && pc < 0xe300)
        assert(
          sp >= 0xea97,
          "generated stack crossed qualified caller-frame floor",
        );
      if (pc >= 0x800 && pc < 0xe300)
        lifetime.activationMaximum = Math.max(
          lifetime.activationMaximum ?? 0,
          cpu.read_ram(0x582a, 1)[0],
        );
      if (pc !== 0 || cpu.boot_rom_enabled()) return;
      const snapshot = generatedSnapshots.get(lifetime);
      assert(snapshot, "generated entry snapshot required");
      assert.deepEqual(Buffer.from(cpu.read_ram(0x800, 0x5000)), snapshot.code);
      assert.equal(cpu.read_ram(0x604d, 1)[0], snapshot.afterWritable);
      const stateBytes = cpu.read_ram(0x5824, 41);
      assert.equal(stateBytes[6], 0, "terminal depth must be released");
      const name = lifetime.tool.slice(0, -4);
      if (["R7", "R8", "F7"].includes(name))
        assert.equal(lifetime.activationMaximum, 8);
      if (name === "R8") {
        assert.equal(stateBytes[0], 3);
        assert.equal(stateBytes[1], 5);
        assert.equal(stateBytes[3] | (stateBytes[4] << 8), 94);
      } else if (name === "F7") {
        assert.equal(stateBytes[0], 3);
        assert.equal(stateBytes[1], 6);
        assert.equal(stateBytes[5], 7);
      } else assert.equal(stateBytes[0], 2);
      if (name === "W2048") {
        assert.equal(stateBytes[37] | (stateBytes[38] << 8), 0x584d);
        assert.equal(stateBytes[39] | (stateBytes[40] << 8), 2048);
        assert.deepEqual(Array.from(cpu.read_ram(0x584d, 1)), [65]);
        assert.equal(cpu.read_ram(0x5c4c, 1)[0], 66);
        assert.equal(cpu.read_ram(0x5c4d, 1)[0], 89);
        assert.equal(cpu.read_ram(0x604c, 1)[0], 90);
      }
      lifetime.nucleusTerminal = Array.from(stateBytes);
    },
  };
}

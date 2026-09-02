const RECORD_BYTES = 128;

interface BiosCpuState {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
}

export interface BdosDiskParameterBlockFixture {
  sectorsPerTrack: number;
  blockShift: number;
  blockMask: number;
  extentMask: number;
  maximumBlock: number;
  maximumDirectoryEntry: number;
  directoryAllocation0: number;
  directoryAllocation1: number;
  checkVectorBytes: number;
  reservedTracks: number;
}

export interface BdosBiosDriveFixture {
  number: number;
  dphAddress: number;
  directoryBufferAddress: number;
  dpbAddress: number;
  checkVectorAddress: number;
  allocationVectorAddress: number;
  translationTableAddress?: number;
  firstSector?: number;
  defaultRecordByte?: number;
  dpb: BdosDiskParameterBlockFixture;
  records?: Array<{
    record: number;
    bytes?: number[];
    fill?: number;
    patches?: Array<{
      offset: number;
      bytes: number[];
    }>;
  }>;
}

export interface BdosBiosDiskFixture {
  drives: BdosBiosDriveFixture[];
}

export interface BdosBiosDiskWrite {
  drive: number;
  record: number;
  bytes: number[];
}

export interface BdosBiosDiskSnapshot {
  selectedDrive: number;
  track: number;
  sector: number;
  dma: number;
  writes: BdosBiosDiskWrite[];
  records: Array<{
    drive: number;
    record: number;
    bytes: number[];
  }>;
}

interface RuntimeDrive {
  fixture: BdosBiosDriveFixture;
  records: Map<number, Uint8Array>;
}

function word(high: number, low: number): number {
  return ((high & 0xff) << 8) | (low & 0xff);
}

function setWord(memory: Uint8Array, address: number, value: number): void {
  memory[address & 0xffff] = value & 0xff;
  memory[(address + 1) & 0xffff] = (value >>> 8) & 0xff;
}

function setHl(state: BiosCpuState, value: number): void {
  state.h = (value >>> 8) & 0xff;
  state.l = value & 0xff;
}

function assertByte(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${field} must be a byte`);
  }
}

function assertWord(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${field} must be a word`);
  }
}

function assertRange(address: number, length: number, field: string): void {
  assertWord(address, field);
  if (length < 0 || address + length > 0x10000) {
    throw new Error(`${field} range exceeds Z80 memory`);
  }
}

function allocationVectorBytes(dpb: BdosDiskParameterBlockFixture): number {
  return Math.floor(dpb.maximumBlock / 8) + 1;
}

function driveCapacityRecords(drive: BdosBiosDriveFixture): number {
  const recordsPerBlock = 1 << drive.dpb.blockShift;
  return (
    drive.dpb.reservedTracks * drive.dpb.sectorsPerTrack +
    (drive.dpb.maximumBlock + 1) * recordsPerBlock
  );
}

function validateDrive(drive: BdosBiosDriveFixture): void {
  assertByte(drive.number, "drive number");
  assertRange(drive.dphAddress, 16, "DPH");
  assertRange(drive.directoryBufferAddress, RECORD_BYTES, "directory buffer");
  assertRange(drive.dpbAddress, 15, "DPB");
  assertRange(
    drive.checkVectorAddress,
    drive.dpb.checkVectorBytes,
    "check vector",
  );
  assertRange(
    drive.allocationVectorAddress,
    allocationVectorBytes(drive.dpb),
    "allocation vector",
  );
  assertWord(drive.translationTableAddress ?? 0, "translation table address");
  assertWord(drive.dpb.sectorsPerTrack, "sectors per track");
  assertByte(drive.dpb.blockShift, "block shift");
  assertByte(drive.dpb.blockMask, "block mask");
  assertByte(drive.dpb.extentMask, "extent mask");
  assertWord(drive.dpb.maximumBlock, "maximum block");
  assertWord(drive.dpb.maximumDirectoryEntry, "maximum directory entry");
  assertByte(drive.dpb.directoryAllocation0, "directory allocation byte 0");
  assertByte(drive.dpb.directoryAllocation1, "directory allocation byte 1");
  assertWord(drive.dpb.checkVectorBytes, "check vector byte count");
  assertWord(drive.dpb.reservedTracks, "reserved tracks");
  assertByte(drive.firstSector ?? 1, "first sector");
  assertByte(drive.defaultRecordByte ?? 0, "default record byte");
  for (const record of drive.records ?? []) {
    if (
      !Number.isInteger(record.record) ||
      record.record < 0 ||
      record.record >= driveCapacityRecords(drive)
    ) {
      throw new Error(`drive ${drive.number} record is out of range`);
    }
    if ((record.bytes === undefined) === (record.fill === undefined)) {
      throw new Error(
        `drive ${drive.number} record must define exactly one of bytes and fill`,
      );
    }
    if (record.bytes !== undefined && record.bytes.length !== RECORD_BYTES) {
      throw new Error(
        `drive ${drive.number} record bytes must contain 128 bytes`,
      );
    }
    if (record.bytes !== undefined) {
      record.bytes.forEach((value) => assertByte(value, "record byte"));
    }
    if (record.fill !== undefined) assertByte(record.fill, "record fill");
    for (const patch of record.patches ?? []) {
      if (
        !Number.isInteger(patch.offset) ||
        patch.offset < 0 ||
        patch.offset + patch.bytes.length > RECORD_BYTES
      ) {
        throw new Error(`drive ${drive.number} record patch is out of range`);
      }
      patch.bytes.forEach((value) => assertByte(value, "record patch byte"));
    }
  }
}

function materializeRecord(
  record: NonNullable<BdosBiosDriveFixture["records"]>[number],
): Uint8Array {
  const bytes =
    record.bytes === undefined
      ? new Uint8Array(RECORD_BYTES).fill(record.fill ?? 0)
      : Uint8Array.from(record.bytes);
  for (const patch of record.patches ?? []) {
    bytes.set(patch.bytes, patch.offset);
  }
  return bytes;
}

export class BdosBiosDiskDouble {
  readonly ownedWritableAddresses = new Set<number>();
  readonly memoryWrittenAddresses = new Set<number>();

  #drives = new Map<number, RuntimeDrive>();
  #selectedDrive = 0;
  #track = 0;
  #sector = 1;
  #dma = 0x0080;
  #writes: BdosBiosDiskWrite[] = [];

  constructor(
    fixture: BdosBiosDiskFixture,
    private readonly memory: Uint8Array,
  ) {
    if (fixture.drives.length === 0) {
      throw new Error("BIOS disk fixture must provide at least one drive");
    }
    for (const drive of fixture.drives) {
      validateDrive(drive);
      if (this.#drives.has(drive.number)) {
        throw new Error(`duplicate BIOS drive ${drive.number}`);
      }
      const records = new Map<number, Uint8Array>();
      for (const record of drive.records ?? []) {
        records.set(record.record, materializeRecord(record));
      }
      this.#drives.set(drive.number, { fixture: drive, records });
      this.#installDriveTables(drive);
    }
  }

  beginCall(): void {
    this.memoryWrittenAddresses.clear();
  }

  handle(entry: number, state: BiosCpuState): void {
    if (entry === 8) {
      this.#track = 0;
      return;
    }
    if (entry === 9) {
      const drive = this.#drives.get(state.c & 0xff);
      if (drive === undefined) {
        setHl(state, 0);
      } else {
        this.#selectedDrive = drive.fixture.number;
        setHl(state, drive.fixture.dphAddress);
      }
      return;
    }
    if (entry === 10) {
      this.#track = word(state.b, state.c);
      return;
    }
    if (entry === 11) {
      this.#sector = word(state.b, state.c);
      return;
    }
    if (entry === 12) {
      this.#dma = word(state.b, state.c);
      return;
    }
    if (entry === 13) {
      this.#read(state);
      return;
    }
    if (entry === 14) {
      this.#write(state);
      return;
    }
    if (entry === 16) this.#translateSector(state);
  }

  snapshot(): BdosBiosDiskSnapshot {
    const records = [...this.#drives.values()]
      .flatMap((drive) =>
        [...drive.records.entries()].map(([record, bytes]) => ({
          drive: drive.fixture.number,
          record,
          bytes: [...bytes],
        })),
      )
      .sort(
        (left, right) => left.drive - right.drive || left.record - right.record,
      );
    return {
      selectedDrive: this.#selectedDrive,
      track: this.#track,
      sector: this.#sector,
      dma: this.#dma,
      writes: this.#writes.map((write) => ({
        ...write,
        bytes: [...write.bytes],
      })),
      records,
    };
  }

  #installDriveTables(drive: BdosBiosDriveFixture): void {
    const dph = drive.dphAddress;
    setWord(this.memory, dph, drive.translationTableAddress ?? 0);
    this.memory.fill(0, dph + 2, dph + 8);
    setWord(this.memory, dph + 8, drive.directoryBufferAddress);
    setWord(this.memory, dph + 10, drive.dpbAddress);
    setWord(this.memory, dph + 12, drive.checkVectorAddress);
    setWord(this.memory, dph + 14, drive.allocationVectorAddress);

    const dpb = drive.dpbAddress;
    setWord(this.memory, dpb, drive.dpb.sectorsPerTrack);
    this.memory[dpb + 2] = drive.dpb.blockShift;
    this.memory[dpb + 3] = drive.dpb.blockMask;
    this.memory[dpb + 4] = drive.dpb.extentMask;
    setWord(this.memory, dpb + 5, drive.dpb.maximumBlock);
    setWord(this.memory, dpb + 7, drive.dpb.maximumDirectoryEntry);
    this.memory[dpb + 9] = drive.dpb.directoryAllocation0;
    this.memory[dpb + 10] = drive.dpb.directoryAllocation1;
    setWord(this.memory, dpb + 11, drive.dpb.checkVectorBytes);
    setWord(this.memory, dpb + 13, drive.dpb.reservedTracks);

    this.memory.fill(
      0,
      drive.directoryBufferAddress,
      drive.directoryBufferAddress + RECORD_BYTES,
    );
    this.memory.fill(
      0,
      drive.checkVectorAddress,
      drive.checkVectorAddress + drive.dpb.checkVectorBytes,
    );
    this.memory.fill(
      0,
      drive.allocationVectorAddress,
      drive.allocationVectorAddress + allocationVectorBytes(drive.dpb),
    );
    for (let offset = 2; offset < 8; offset += 1) {
      this.ownedWritableAddresses.add(dph + offset);
    }
    for (let offset = 0; offset < RECORD_BYTES; offset += 1) {
      this.ownedWritableAddresses.add(drive.directoryBufferAddress + offset);
    }
    for (let offset = 0; offset < drive.dpb.checkVectorBytes; offset += 1) {
      this.ownedWritableAddresses.add(drive.checkVectorAddress + offset);
    }
    for (
      let offset = 0;
      offset < allocationVectorBytes(drive.dpb);
      offset += 1
    ) {
      this.ownedWritableAddresses.add(drive.allocationVectorAddress + offset);
    }
  }

  #currentRecord(): { drive: RuntimeDrive; record: number } | undefined {
    const drive = this.#drives.get(this.#selectedDrive);
    if (drive === undefined) return undefined;
    const firstSector = drive.fixture.firstSector ?? 1;
    const sectorOffset = this.#sector - firstSector;
    if (sectorOffset < 0 || sectorOffset >= drive.fixture.dpb.sectorsPerTrack) {
      return undefined;
    }
    const record =
      this.#track * drive.fixture.dpb.sectorsPerTrack + sectorOffset;
    if (record < 0 || record >= driveCapacityRecords(drive.fixture)) {
      return undefined;
    }
    return { drive, record };
  }

  #read(state: BiosCpuState): void {
    const current = this.#currentRecord();
    if (current === undefined) {
      state.a = 1;
      return;
    }
    const bytes =
      current.drive.records.get(current.record) ??
      new Uint8Array(RECORD_BYTES).fill(
        current.drive.fixture.defaultRecordByte ?? 0,
      );
    for (let offset = 0; offset < RECORD_BYTES; offset += 1) {
      const address = (this.#dma + offset) & 0xffff;
      this.memory[address] = bytes[offset] ?? 0;
      this.memoryWrittenAddresses.add(address);
    }
    state.a = 0;
  }

  #write(state: BiosCpuState): void {
    const current = this.#currentRecord();
    if (current === undefined) {
      state.a = 1;
      return;
    }
    const bytes = new Uint8Array(RECORD_BYTES);
    for (let offset = 0; offset < RECORD_BYTES; offset += 1) {
      bytes[offset] = this.memory[(this.#dma + offset) & 0xffff] ?? 0;
    }
    current.drive.records.set(current.record, bytes);
    this.#writes.push({
      drive: current.drive.fixture.number,
      record: current.record,
      bytes: [...bytes],
    });
    state.a = 0;
  }

  #translateSector(state: BiosCpuState): void {
    const logicalSector = word(state.b, state.c);
    const tableAddress = word(state.d, state.e);
    if (tableAddress !== 0) {
      setHl(state, this.memory[(tableAddress + logicalSector) & 0xffff] ?? 0);
      return;
    }
    const drive = this.#drives.get(this.#selectedDrive);
    setHl(state, logicalSector + (drive?.fixture.firstSector ?? 1));
  }
}

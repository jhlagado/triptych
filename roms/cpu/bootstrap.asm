; ESP32-hosted Z80 SBC cold bootstrap.
;
; The 256-byte ROM is visible for reads at $0000 after reset. It loads the
; two-track CP/M proof system from linear records 0..51, copies a seven-byte
; overlay-disable stub above the ROM window, and enters the guest BIOS.

        .org    $0000

SYSTEM_BASE             .equ $E400
DISABLE_STUB_ADDRESS    .equ $E300
BIOS_BASE               .equ $FA00
CURRENT_RECORD          .equ $E2F0
RECORDS_REMAINING       .equ $E2F1
SYSTEM_RECORDS          .equ 52
RECORD_BYTES            .equ 128

PORT_SERIAL_DATA        .equ $00
PORT_DISK_STATUS        .equ $10
PORT_DISK_DRIVE         .equ $11
PORT_DISK_RECORD_0      .equ $12
PORT_DISK_RECORD_1      .equ $13
PORT_DISK_RECORD_2      .equ $14
PORT_DISK_RECORD_3      .equ $15
PORT_DISK_DATA          .equ $16
PORT_SYSTEM_CONTROL     .equ $20

DISK_COMMAND_READ       .equ 1
DISK_STATUS_BUSY        .equ 1
DISK_STATUS_DATA        .equ 2
DISK_STATUS_ERROR       .equ 4
ROM_DISABLE_KEY         .equ $A5

Start:
        di
        ld      sp,$E300
        xor     a
        out     (PORT_DISK_DRIVE),a
        out     (PORT_DISK_RECORD_0),a
        out     (PORT_DISK_RECORD_1),a
        out     (PORT_DISK_RECORD_2),a
        out     (PORT_DISK_RECORD_3),a
        ld      (CURRENT_RECORD),a
        ld      a,SYSTEM_RECORDS
        ld      (RECORDS_REMAINING),a
        ld      hl,SYSTEM_BASE

ReadNextRecord:
        ld      a,(CURRENT_RECORD)
        out     (PORT_DISK_RECORD_0),a
        ld      a,DISK_COMMAND_READ
        out     (PORT_DISK_STATUS),a
        call    WaitForRead
        jr      nz,BootError
        ld      b,RECORD_BYTES
        ld      c,PORT_DISK_DATA
        inir
        call    WaitForCompletion
        jr      nz,BootError
        ld      a,(CURRENT_RECORD)
        inc     a
        ld      (CURRENT_RECORD),a
        ld      a,(RECORDS_REMAINING)
        dec     a
        ld      (RECORDS_REMAINING),a
        jr      nz,ReadNextRecord

        ld      hl,DisableStub
        ld      de,DISABLE_STUB_ADDRESS
        ld      bc,DisableStubEnd-DisableStub
        ldir
        jp      DISABLE_STUB_ADDRESS

WaitForRead:
        in      a,(PORT_DISK_STATUS)
        bit     0,a
        jr      nz,WaitForRead
        bit     2,a
        jr      nz,DiskFailure
        bit     1,a
        jr      z,WaitForRead
        xor     a
        ret

WaitForCompletion:
        in      a,(PORT_DISK_STATUS)
        bit     0,a
        jr      nz,WaitForCompletion
        and     DISK_STATUS_ERROR|DISK_STATUS_DATA
        ret     z

DiskFailure:
        ld      a,1
        or      a
        ret

BootError:
        ld      a,'E'
        out     (PORT_SERIAL_DATA),a
        halt
        jr      BootError

DisableStub:
        ld      a,ROM_DISABLE_KEY
        out     (PORT_SYSTEM_CONTROL),a
        jp      BIOS_BASE
DisableStubEnd:

        .binto  $00FF

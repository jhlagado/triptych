; Record-zero payload for the Stage 1 cold-boot fixture. It proves serial
; execution, a complete 128-byte record write, explicit flush, and HALT.

        .org    $0000

PORT_SERIAL_DATA        .equ $00
PORT_DISK_STATUS        .equ $10
PORT_DISK_DRIVE         .equ $11
PORT_DISK_RECORD_0      .equ $12
PORT_DISK_RECORD_1      .equ $13
PORT_DISK_RECORD_2      .equ $14
PORT_DISK_RECORD_3      .equ $15
PORT_DISK_DATA          .equ $16

DISK_COMMAND_WRITE      .equ 2
DISK_COMMAND_FLUSH      .equ 3

Start:
        ld      a,$42
        out     (PORT_SERIAL_DATA),a
        xor     a
        out     (PORT_DISK_DRIVE),a
        ld      a,1
        out     (PORT_DISK_RECORD_0),a
        xor     a
        out     (PORT_DISK_RECORD_1),a
        out     (PORT_DISK_RECORD_2),a
        out     (PORT_DISK_RECORD_3),a
        ld      a,DISK_COMMAND_WRITE
        out     (PORT_DISK_STATUS),a
        ld      b,128
        ld      a,$5A

WriteRecord:
        out     (PORT_DISK_DATA),a
        djnz    WriteRecord

        ld      a,DISK_COMMAND_FLUSH
        out     (PORT_DISK_STATUS),a
        ld      a,$50
        out     (PORT_SERIAL_DATA),a
        halt

        .binto  $007F

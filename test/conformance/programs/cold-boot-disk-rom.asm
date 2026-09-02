; Stage 1 conformance ROM: perform a block-free record-zero cold load, copy a
; seven-byte overlay-disable stub to high RAM, and enter the loaded program.
;
; The explicit IN/LD/INC/DJNZ loop is intentional. Conformance providers must
; agree on instruction steps, while Z80 block-repeat instructions are exposed
; differently by some debugger APIs.

        .org    $0000

PORT_DISK_STATUS        .equ $10
PORT_DISK_DRIVE         .equ $11
PORT_DISK_RECORD_0      .equ $12
PORT_DISK_RECORD_1      .equ $13
PORT_DISK_RECORD_2      .equ $14
PORT_DISK_RECORD_3      .equ $15
PORT_DISK_DATA          .equ $16
PORT_SYSTEM_CONTROL     .equ $20

DISK_COMMAND_READ       .equ 1
ROM_DISABLE_KEY         .equ $A5
DISABLE_STUB_ADDRESS    .equ $FF00

Start:
        di
        ld      sp,$FFFE
        xor     a
        out     (PORT_DISK_DRIVE),a
        out     (PORT_DISK_RECORD_0),a
        out     (PORT_DISK_RECORD_1),a
        out     (PORT_DISK_RECORD_2),a
        out     (PORT_DISK_RECORD_3),a
        ld      a,DISK_COMMAND_READ
        out     (PORT_DISK_STATUS),a
        ld      hl,$0000
        ld      b,128

ReadRecord:
        in      a,(PORT_DISK_DATA)
        ld      (hl),a
        inc     hl
        djnz    ReadRecord

        ld      hl,DISABLE_STUB_ADDRESS
        ld      (hl),$3E            ; LD A,$A5
        inc     hl
        ld      (hl),ROM_DISABLE_KEY
        inc     hl
        ld      (hl),$D3            ; OUT ($20),A
        inc     hl
        ld      (hl),PORT_SYSTEM_CONTROL
        inc     hl
        ld      (hl),$C3            ; JP $0000
        inc     hl
        ld      (hl),$00
        inc     hl
        ld      (hl),$00
        jp      DISABLE_STUB_ADDRESS

        .binto  $00FF

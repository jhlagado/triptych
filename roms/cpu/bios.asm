; CP/M 2.2 compatibility-proof BIOS for the ESP32-hosted Z80 SBC profile.

        .org    $FA00

CCP_BASE                .equ $E400
BDOS_ENTRY              .equ $EC06
WARM_BOOT_RECORDS       .equ 44
RECORDS_PER_TRACK       .equ 26
RECORD_BYTES            .equ 128

PORT_SERIAL_DATA        .equ $00
PORT_SERIAL_STATUS      .equ $01
PORT_DISK_STATUS        .equ $10
PORT_DISK_DRIVE         .equ $11
PORT_DISK_RECORD_0      .equ $12
PORT_DISK_RECORD_1      .equ $13
PORT_DISK_RECORD_2      .equ $14
PORT_DISK_RECORD_3      .equ $15
PORT_DISK_DATA          .equ $16

DISK_COMMAND_READ       .equ 1
DISK_COMMAND_WRITE      .equ 2
DISK_COMMAND_FLUSH      .equ 3
DISK_STATUS_BUSY        .equ 1
DISK_STATUS_DATA        .equ 2
DISK_STATUS_ERROR       .equ 4

IOBYTE                  .equ $0003
CURRENT_DISK            .equ $0004
DEFAULT_DMA             .equ $0080

; CP/M 2.2 BIOS jump table. The ordinal and three-byte width are ABI.
        jp      ColdBoot
        jp      WarmBoot
        jp      ConsoleStatus
        jp      ConsoleInput
        jp      ConsoleOutput
        jp      ListOutput
        jp      PunchOutput
        jp      ReaderInput
        jp      Home
        jp      SelectDisk
        jp      SetTrack
        jp      SetSector
        jp      SetDma
        jp      ReadSector
        jp      WriteSector
        jp      ListStatus
        jp      SectorTranslate

ColdBoot:
        di
        ld      sp,BootStackTop
        xor     a
        ld      (IOBYTE),a
        ld      (CURRENT_DISK),a
        ld      c,a
        call    InstallPageZero
        jp      CCP_BASE

WarmBoot:
        di
        ld      sp,BootStackTop
        xor     a
        out     (PORT_DISK_DRIVE),a
        out     (PORT_DISK_RECORD_0),a
        out     (PORT_DISK_RECORD_1),a
        out     (PORT_DISK_RECORD_2),a
        out     (PORT_DISK_RECORD_3),a
        ld      (BootRecord),a
        ld      a,WARM_BOOT_RECORDS
        ld      (BootRecordsRemaining),a
        ld      hl,CCP_BASE

WarmBootRead:
        ld      a,(BootRecord)
        out     (PORT_DISK_RECORD_0),a
        ld      a,DISK_COMMAND_READ
        out     (PORT_DISK_STATUS),a
        call    WaitForRead
        jr      nz,BootDiskError
        ld      b,RECORD_BYTES
        ld      c,PORT_DISK_DATA
        inir
        call    WaitForCompletion
        jr      nz,BootDiskError
        ld      a,(BootRecord)
        inc     a
        ld      (BootRecord),a
        ld      a,(BootRecordsRemaining)
        dec     a
        ld      (BootRecordsRemaining),a
        jr      nz,WarmBootRead
        ld      a,(CURRENT_DISK)
        ld      c,a
        call    InstallPageZero
        jp      CCP_BASE

BootDiskError:
        ld      hl,BootErrorMessage
        call    PrintZeroTerminated
        halt
        jr      BootDiskError

InstallPageZero:
        ld      a,$C3
        ld      ($0000),a
        ld      hl,WarmBoot
        ld      ($0001),hl
        ld      ($0005),a
        ld      hl,BDOS_ENTRY
        ld      ($0006),hl
        ret

ConsoleStatus:
        in      a,(PORT_SERIAL_STATUS)
        and     1
        ret     z
        ld      a,$FF
        ret

ConsoleInput:
        call    ConsoleStatus
        or      a
        jr      z,ConsoleInput
        in      a,(PORT_SERIAL_DATA)
        and     $7F
        ret

ConsoleOutput:
        ld      a,c
        out     (PORT_SERIAL_DATA),a
        ret

ListOutput:
PunchOutput:
        ret

ReaderInput:
        ld      a,$1A
        ret

Home:
        ld      bc,0

SetTrack:
        ld      (CurrentTrack),bc
        ret

SelectDisk:
        ld      a,c
        or      a
        ld      hl,0
        ret     nz
        ld      hl,DiskParameterHeader
        ret

SetSector:
        ld      (CurrentSector),bc
        ret

SetDma:
        ld      (CurrentDma),bc
        ret

ReadSector:
        call    SelectCurrentAddress
        ret     nz
        ld      a,DISK_COMMAND_READ
        out     (PORT_DISK_STATUS),a
        call    WaitForRead
        ret     nz
        ld      hl,(CurrentDma)
        ld      b,RECORD_BYTES
        ld      c,PORT_DISK_DATA
        inir
        call    WaitForCompletion
        ret

WriteSector:
        call    SelectCurrentAddress
        ret     nz
        ld      a,DISK_COMMAND_WRITE
        out     (PORT_DISK_STATUS),a
        call    WaitForWrite
        ret     nz
        ld      hl,(CurrentDma)
        ld      b,RECORD_BYTES
        ld      c,PORT_DISK_DATA
        otir
        call    WaitForCompletion
        ret     nz
        ld      a,DISK_COMMAND_FLUSH
        out     (PORT_DISK_STATUS),a
        call    WaitForIdle
        ret

; Convert CP/M's 16-bit track and one-based sector to a 32-bit linear record.
; The IBM 3740 proof disk contains only 2,002 records, so the upper half is zero.
SelectCurrentAddress:
        xor     a
        out     (PORT_DISK_DRIVE),a
        ld      hl,(CurrentTrack)
        ld      d,h
        ld      e,l
        add     hl,hl
        add     hl,de
        add     hl,hl
        add     hl,hl
        add     hl,de
        add     hl,hl
        ld      bc,(CurrentSector)
        dec     bc
        add     hl,bc
        ld      a,l
        out     (PORT_DISK_RECORD_0),a
        ld      a,h
        out     (PORT_DISK_RECORD_1),a
        xor     a
        out     (PORT_DISK_RECORD_2),a
        out     (PORT_DISK_RECORD_3),a
        ret

WaitForRead:
        in      a,(PORT_DISK_STATUS)
        bit     0,a
        jr      nz,WaitForRead
        bit     2,a
        jr      nz,DiskError
        bit     1,a
        jr      z,WaitForRead
        xor     a
        ret

WaitForWrite:
        in      a,(PORT_DISK_STATUS)
        bit     0,a
        jr      nz,WaitForWrite
        bit     2,a
        jr      nz,DiskError
        bit     1,a
        jr      z,WaitForWrite
        xor     a
        ret

WaitForCompletion:
        in      a,(PORT_DISK_STATUS)
        bit     0,a
        jr      nz,WaitForCompletion
        bit     2,a
        jr      nz,DiskError
        bit     1,a
        jr      nz,DiskError
        xor     a
        ret

WaitForIdle:
        in      a,(PORT_DISK_STATUS)
        bit     0,a
        jr      nz,WaitForIdle
        bit     2,a
        jr      nz,DiskError
        xor     a
        ret

DiskError:
        ld      a,1
        or      a
        ret

ListStatus:
        xor     a
        ret

SectorTranslate:
        ld      h,b
        ld      l,c
        inc     hl
        ret

PrintZeroTerminated:
        ld      a,(hl)
        or      a
        ret     z
        out     (PORT_SERIAL_DATA),a
        inc     hl
        jr      PrintZeroTerminated

BootErrorMessage:
        .db     "CP/M BOOT ERROR",13,10,0

BootRecord:
        .db     0
BootRecordsRemaining:
        .db     0

CurrentTrack:
        .dw     0
CurrentSector:
        .dw     1
CurrentDma:
        .dw     DEFAULT_DMA

DiskParameterHeader:
        .dw     0
        .dw     0,0,0
        .dw     DirectoryBuffer
        .dw     DiskParameterBlock
        .dw     ChecksumVector
        .dw     AllocationVector

DiskParameterBlock:
        .dw     26
        .db     3
        .db     7
        .db     0
        .dw     242
        .dw     63
        .db     $C0,$00
        .dw     16
        .dw     2

DirectoryBuffer:
        .ds     128
ChecksumVector:
        .ds     16
AllocationVector:
        .ds     31

        .ds     32
BootStackTop:

        .binto  $FDFF

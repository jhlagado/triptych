; ESP32-hosted Z80 SBC cold bootstrap.
;
; The 256-byte ROM is visible for reads at $0000 after reset. It loads the
; two-track CP/M proof system from linear records 0..51, copies a seven-byte
; overlay-disable stub above the ROM window, and enters the guest BIOS.

        ORG     $0000

SYSBASE  EQU     $E400
STUBADDR EQU     $E300
BIOSBASE EQU     $FA00
CURREC   EQU     $E2F0
RECSLEFT EQU     $E2F1
SYSRECS  EQU     52
RECBYTES EQU     128

SERDATA  EQU     $00
DSKSTAT  EQU     $10
DSKDRIVE EQU     $11
DSKREC0  EQU     $12
DSKREC1  EQU     $13
DSKREC2  EQU     $14
DSKREC3  EQU     $15
DSKDATA  EQU     $16
SYSCTRL  EQU     $20

CMDREAD  EQU     1
DSKBUSY  EQU     1
DSKREADY EQU     2
DSKERROR EQU     4
ROMKEY   EQU     $A5

Start:
        di
        ld      sp,$E300
        xor     a
        out     (DSKDRIVE),a
        out     (DSKREC0),a
        out     (DSKREC1),a
        out     (DSKREC2),a
        out     (DSKREC3),a
        ld      (CURREC),a
        ld      a,SYSRECS
        ld      (RECSLEFT),a
        ld      hl,SYSBASE

READNEXT:
        ld      a,(CURREC)
        out     (DSKREC0),a
        ld      a,CMDREAD
        out     (DSKSTAT),a
        call    WAITREAD
        jr      nz,BOOTERR
        ld      b,RECBYTES
        ld      c,DSKDATA
        inir
        call    WAITDONE
        jr      nz,BOOTERR
        ld      a,(CURREC)
        inc     a
        ld      (CURREC),a
        ld      a,(RECSLEFT)
        dec     a
        ld      (RECSLEFT),a
        jr      nz,READNEXT

        ld      hl,DISSTUB
        ld      de,STUBADDR
        ld      bc,STUBLEN
        ldir
        jp      STUBADDR

WAITREAD:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITREAD
        bit     2,a
        jr      nz,DISKFAIL
        bit     1,a
        jr      z,WAITREAD
        xor     a
        ret

WAITDONE:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITDONE
        and     DSKERROR|DSKREADY
        ret     z

DISKFAIL:
        ld      a,1
        or      a
        ret

BOOTERR:
        ld      a,'E'
        out     (SERDATA),a
        halt
        jr      BOOTERR

DISSTUB:
        ld      a,ROMKEY
        out     (SYSCTRL),a
        jp      BIOSBASE
STUBEND:
STUBLEN  EQU     STUBEND-DISSTUB

        DS      $0100-$,0

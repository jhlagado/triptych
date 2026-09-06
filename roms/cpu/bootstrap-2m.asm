; Triptych two-MiB profile cold bootstrap.
;
; The 256-byte ROM is visible for reads at 0000 after reset. It loads exactly
; 52 contiguous system records from A into the selected resident memory layout:
; 16 CCP records, 28 BDOS records and eight BIOS records. The remainder of the
; reserved disk track is not loaded. ALVs above the BIOS are initialized later
; by BDOS login, not copied from the system records.
;
; The builder supplies SYSBASE, BIOSBASE, STUBADDR, CURREC and RECSLEFT as
; ordinary EQU statements. The scratch counters and stack are below SYSBASE;
; their addresses change with the configured resident profile.
;
        ORG     $0000

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

; In: reset ROM overlay active, A contains matching 52 records.
; Out: PC=BIOS cold entry, overlay off; errors print E and halt.
; Clobbers AF/BC/DE/HL/SP, disables interrupts; no return.
Start:
        di
        ld      sp,STUBADDR
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

; Instruction fetches must continue outside the overlay after it is disabled.
; Copy the seven-byte OUT-and-JP stub to RAM only after the last loader call:
; STUBADDR is also the top of the downward-growing loader stack, so the stub
; cannot overwrite a live call frame.
        ld      hl,DISSTUB
        ld      de,STUBADDR
        ld      bc,STUBLEN
        ldir
        jp      STUBADDR

; In: READ_RECORD issued. Out: A=0/Z once 128-byte input is available;
; A=1/NZ on controller error. Clobbers AF; other registers preserved.
; Polling has no software timeout; the controller must complete or report error.
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

; In: all 128 record bytes consumed. Out: A=0/Z only after busy and transfer
; flags clear; A=1/NZ on error or incomplete transfer. Clobbers AF; stack balanced.
WAITDONE:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITDONE
        and     DSKERROR|DSKREADY
        ret     z

; Shared command-error return: A=1/NZ, carry clear. Clobbers AF only.
; RET consumes the wait helper's existing return word; stack remains balanced.
DISKFAIL:
        ld      a,1
        or      a
        ret

; Terminal boot failure. In: a system-record read failed. Out: serial E, then
; halt with interrupts disabled; no caller resumes. Clobbers A, preserves flags.
; Successfully loaded earlier records remain in RAM, but no BIOS entry occurs.
BOOTERR:
        ld      a,'E'
        out     (SERDATA),a
        halt
        jr      BOOTERR

; Enter by JP after all loader calls have returned. Out: overlay disabled,
; PC=BIOSBASE. Clobbers A; flags unchanged. No return or additional stack use.
DISSTUB:
        ld      a,ROMKEY
        out     (SYSCTRL),a
        jp      BIOSBASE
STUBEND:
STUBLEN  EQU     STUBEND-DISSTUB

        DS      $0100-$,0

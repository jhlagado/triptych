; Triptych CP/M BIOS: disk-loaded Z80 machine interface, resident in RAM.

        ORG     $FA00

CCP_BASE EQU     $E400
BDOSENT  EQU     $EC06
WARMRECS EQU     44
TRACKREC EQU     26
RECBYTES EQU     128

SERDATA  EQU     $00
SERSTAT  EQU     $01
DSKSTAT  EQU     $10
DSKDRIVE EQU     $11
DSKREC0  EQU     $12
DSKREC1  EQU     $13
DSKREC2  EQU     $14
DSKREC3  EQU     $15
DSKDATA  EQU     $16

CMDREAD  EQU     1
CMDWRITE EQU     2
CMDFLUSH EQU     3
DSKBUSY  EQU     1
DSKREADY EQU     2
DSKERROR EQU     4

IOBYTE   EQU     $0003
CURDISK  EQU     $0004
DFLTDMA  EQU     $0080

; CP/M 2.2 BIOS jump table. The ordinal and three-byte width are ABI.
        jp      ColdBoot
        jp      WarmBoot
        jp      CONSTAT
        jp      CONIN
        jp      CONOUT
        jp      LISTOUT
        jp      PUNCHOUT
        jp      READER
        jp      Home
        jp      SELDSK
        jp      SetTrack
        jp      SETSEC
        jp      SetDma
        jp      READSEC
        jp      WRITESEC
        jp      LISTSTAT
        jp      SECTRAN

ColdBoot:
        di
        ld      sp,BOOTSP
        xor     a
        ld      (IOBYTE),a
        ld      (CURDISK),a
        ld      c,a
        call    PAGEZERO
        jp      CCP_BASE

WarmBoot:
        di
        ld      sp,BOOTSP
        xor     a
        out     (DSKDRIVE),a
        out     (DSKREC0),a
        out     (DSKREC1),a
        out     (DSKREC2),a
        out     (DSKREC3),a
        ld      (BOOTREC),a
        ld      a,WARMRECS
        ld      (BOOTLEFT),a
        ld      hl,CCP_BASE

WARMREAD:
        ld      a,(BOOTREC)
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
        ld      a,(BOOTREC)
        inc     a
        ld      (BOOTREC),a
        ld      a,(BOOTLEFT)
        dec     a
        ld      (BOOTLEFT),a
        jr      nz,WARMREAD
        ld      a,(CURDISK)
        ld      c,a
        call    PAGEZERO
        jp      CCP_BASE

BOOTERR:
        ld      hl,BOOTMSG
        call    PRINTZ
        halt
        jr      BOOTERR

PAGEZERO:
        ld      a,$C3
        ld      ($0000),a
        ld      hl,WarmBoot
        ld      ($0001),hl
        ld      ($0005),a
        ld      hl,BDOSENT
        ld      ($0006),hl
        ret

CONSTAT:
        in      a,(SERSTAT)
        and     1
        ret     z
        ld      a,$FF
        ret

CONIN:
        call    CONSTAT
        or      a
        jr      z,CONIN
        in      a,(SERDATA)
        and     $7F
        ret

CONOUT:
        ld      a,c
        out     (SERDATA),a
        ret

LISTOUT:
PUNCHOUT:
        ret

READER:
        ld      a,$1A
        ret

Home:
        ld      bc,0

SetTrack:
        ld      (CURTRACK),bc
        ret

SELDSK:
        ld      a,c
        or      a
        ld      hl,0
        ret     nz
        ld      hl,DPHEADER
        ret

SETSEC:
        ld      (CURSECT),bc
        ret

SetDma:
        ld      (CURDMA),bc
        ret

READSEC:
        call    SELADDR
        ret     nz
        ld      a,CMDREAD
        out     (DSKSTAT),a
        call    WAITREAD
        ret     nz
        ld      hl,(CURDMA)
        ld      b,RECBYTES
        ld      c,DSKDATA
        inir
        call    WAITDONE
        ret

WRITESEC:
        call    SELADDR
        ret     nz
        ld      a,CMDWRITE
        out     (DSKSTAT),a
        call    WAITWR
        ret     nz
        ld      hl,(CURDMA)
        ld      b,RECBYTES
        ld      c,DSKDATA
        otir
        call    WAITDONE
        ret     nz
        ld      a,CMDFLUSH
        out     (DSKSTAT),a
        call    WAITIDLE
        ret

; Convert CP/M's 16-bit track and one-based sector to a 32-bit linear record.
; The IBM 3740 proof disk contains only 2,002 records, so the upper half is zero.
SELADDR:
        xor     a
        out     (DSKDRIVE),a
        ld      hl,(CURTRACK)
        ld      d,h
        ld      e,l
        add     hl,hl
        add     hl,de
        add     hl,hl
        add     hl,hl
        add     hl,de
        add     hl,hl
        ld      bc,(CURSECT)
        dec     bc
        add     hl,bc
        ld      a,l
        out     (DSKREC0),a
        ld      a,h
        out     (DSKREC1),a
        xor     a
        out     (DSKREC2),a
        out     (DSKREC3),a
        ret

WAITREAD:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITREAD
        bit     2,a
        jr      nz,DISKERR
        bit     1,a
        jr      z,WAITREAD
        xor     a
        ret

WAITWR:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITWR
        bit     2,a
        jr      nz,DISKERR
        bit     1,a
        jr      z,WAITWR
        xor     a
        ret

WAITDONE:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITDONE
        bit     2,a
        jr      nz,DISKERR
        bit     1,a
        jr      nz,DISKERR
        xor     a
        ret

WAITIDLE:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITIDLE
        bit     2,a
        jr      nz,DISKERR
        xor     a
        ret

DISKERR:
        ld      a,1
        or      a
        ret

LISTSTAT:
        xor     a
        ret

SECTRAN:
        ld      h,b
        ld      l,c
        inc     hl
        ret

PRINTZ:
        ld      a,(hl)
        or      a
        ret     z
        out     (SERDATA),a
        inc     hl
        jr      PRINTZ

BOOTMSG:
        DB      "CP/M BOOT ERROR",13,10,0

BOOTREC:
        DB      0
BOOTLEFT:
        DB      0

CURTRACK:
        DW      0
CURSECT:
        DW      1
CURDMA:
        DW      DFLTDMA

DPHEADER:
        DW      0
        DW      0,0,0
        DW      DIRBUF
        DW      DPBLOCK
        DW      CHKSVEC
        DW      ALLOCVEC

DPBLOCK:
        DW      26
        DB      3
        DB      7
        DB      0
        DW      242
        DW      63
        DB      $C0,$00
        DW      16
        DW      2

DIRBUF:
        DS      128
CHKSVEC:
        DS      16
ALLOCVEC:
        DS      31

        DS      32
BOOTSP:

        DS      $FE00-$,0

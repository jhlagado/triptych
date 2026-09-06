; Triptych A/B 8 MiB BIOS, named resident profile triptych-cpu-v0.1-8m-ab.
; CCP E300..EAFF, BDOS EB00..F8FF; all live BIOS state is below FC00.
; ALV A FC00..FDFE and ALV B FE00..FFFE belong to BDOS; FDFF/FFFF are guards.
; Cold-loaded FC00..FCFF padding is dead before BDOS initializes either ALV.
; Warm boot reloads only CCP/BDOS from A and preserves both ALVs and default drive.

        ORG     $F900

CCP_BASE EQU     $E300
BDOSENT  EQU     $EB06
WARMRECS EQU     44
TRACKREC EQU     128
ALLOCVEC EQU     $FC00
ALLOCB   EQU     $FE00
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
CMDCAP   EQU     4
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
; FLUSH drains the global cache but checkpoints only the selected drive.
; A is mandatory. Skip B only when absent, not merely incompatible with CP/M.
; Direct controller I/O may have dirtied any present B; preserve its checkpoint.
        ld      c,0
        call    SELDSK
        ld      a,h
        or      l
        jp      z,BOOTERR
        call    FLUSH
        jp      nz,BOOTERR
        ld      a,1
        out     (DSKDRIVE),a
        in      a,(DSKSTAT)
        bit     4,a
        jr      z,WARMA
        call    FLUSH
        jp      nz,BOOTERR
WARMA:
        xor     a
        ld      (CURDRIVE),a
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

; Select A or B, requiring exactly 65536 controller records.
; Publish CURDRIVE only after validation; rejected selects retain the last binding.
; In: C=drive. Out: HL=DPH or zero on absent/wrong-size/unsupported drive.
; Clobbers: AF, HL. BC/DE/IX/IY preserved. Stack balanced.
; GET_CAPACITY replaces controller address registers but performs no record I/O.
SELDSK:
        ld      a,c
        cp      2
        ld      hl,0
        ret     nc
        out     (DSKDRIVE),a
        ld      a,CMDCAP
        out     (DSKSTAT),a
        call    WAITIDLE
        ret     nz
        in      a,(DSKREC0)
        or      a
        ret     nz
        in      a,(DSKREC1)
        or      a
        ret     nz
        in      a,(DSKREC2)
        cp      1
        ret     nz
        in      a,(DSKREC3)
        or      a
        ret     nz
        ld      a,c
        ld      (CURDRIVE),a
        ld      hl,DPHEADER
        or      a
        ret     z
        ld      hl,DPHEADB
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
FLUSH:
        ld      a,CMDFLUSH
        out     (DSKSTAT),a
        call    WAITIDLE
        ret

; Validate before converting track/one-based sector to controller address.
; In: CURTRACK=0..511, CURSECT=1..128. Out: A=0/Z success or A=1/NZ error.
; Clobbers: AF, BC, DE, HL. Stack balanced. Invalid coordinates issue no ports.
; The largest valid result is FFFF; capacity is separately the 32-bit 10000.
SELADDR:
        ld      a,(CURDRIVE)
        cp      2
        jp      nc,DISKERR
        ld      bc,(CURSECT)
        ld      a,b
        or      a
        jp      nz,DISKERR
        ld      a,c
        or      a
        jp      z,DISKERR
        cp      129
        jp      nc,DISKERR
        dec     c
        ld      e,c
        ld      d,0
        ld      hl,(CURTRACK)
        ld      a,h
        cp      2
        jp      nc,DISKERR
        ld      b,7
ADDRSHFT:
        add     hl,hl
        djnz    ADDRSHFT
        add     hl,de
        ld      a,(CURDRIVE)
        out     (DSKDRIVE),a
        xor     a
        out     (DSKREC2),a
        out     (DSKREC3),a
        ld      a,l
        out     (DSKREC0),a
        ld      a,h
        out     (DSKREC1),a
        xor     a
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

CURDRIVE:
        DB      $FF
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

DPHEADB:
        DW      0
        DW      0,0,0
        DW      DIRBUF
        DW      DPBLOCK
        DW      CHKSVEC
        DW      ALLOCB

DPBLOCK:
        DW      TRACKREC
        DB      4
        DB      15
        DB      0
        DW      4087
        DW      511
        DB      $FF,$00
        DW      0
        DW      1

DIRBUF:
        DS      128
; CKS=0: no checksum vector is read. This label reserves no bytes.
CHKSVEC:

        DS      32
BOOTSP:

; A negative count rejects any live code/workspace overlap with ALV A.
        DS      $FC00-$,0
; These 256 cold-load padding bytes are never read as BIOS code or data.
        DS      $FD00-$,0

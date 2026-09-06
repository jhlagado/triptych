; Triptych two-MiB BIOS for one through sixteen configured drive slots.
;
; tools/lib/cpm-two-mib-profile.mjs supplies ordinary ATOM EQU statements:
; BIOSBASE, CCP_BASE, BDOSENT, DRIVES and ALLOCVEC. It also appends the DPH
; entries after DPHEADS. The prepared flat source can be assembled with ATOM
; without a host preprocessor. Component origins depend on configured count;
; the disk geometry is identical for every count.
;
; The first 768 loaded bytes contain code, shared data and the boot stack.
; Each configured drive has a stable 16-byte DPH in the final 256-byte table.
; Above the loaded BIOS, each 128-byte allocation slot contains a 127-byte
; BDOS allocation vector and one untouched guard byte. Odd counts leave an
; unused half-page at the top. No allocation vector is cold-loaded here.
;
; Calls are non-reentrant, interrupts remain disabled, and all register names
; below refer to the main Z80 register set. Unlisted registers are preserved.
; The machine controller has one shared cache; each successful FLUSH records
; the selected drive's checkpoint. A sequence of flushes is not a transaction.
;
        ORG     BIOSBASE

WARMRECS EQU     44
TRACKREC EQU     128
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

; In: loaded BIOS, no live callers. Out: PC=CCP, SP=BOOTSP, C=0; no return.
; Clobbers AF/BC/DE/HL; disables interrupts; initializes page zero.
ColdBoot:
        di
        ld      sp,BOOTSP
        xor     a
        ld      (IOBYTE),a
        ld      (CURDISK),a
        ld      c,a
        call    PAGEZERO
        jp      CCP_BASE

; In: present compatible A, page-zero default drive. Out: PC=CCP, C=default,
; SP=BOOTSP or halt. Clobbers AF/BC/DE/HL; disables interrupts; retains ALVs.
WarmBoot:
        di
        ld      sp,BOOTSP
; Warm boot reloads CCP and BDOS from A after all configured checkpoints.
; A must have the expected geometry; a present optional disk must be flushed
; even if its size is unsuitable for this CP/M profile, because direct port
; writes may have modified it.
; Validate mandatory A, then flush every present configured slot before reload.
; Each FLUSH is an independent checkpoint; failures halt before resident reads.
        ld      c,0
        call    SELDSK
        ld      a,h
        or      l
        jp      z,BOOTERR
        call    FLUSH
        jp      nz,BOOTERR
        ld      c,1
WRMFLUSH:
        ld      a,c
        cp      DRIVES
        jr      nc,WARMA
        out     (DSKDRIVE),a
        in      a,(DSKSTAT)
        bit     4,a
        jr      z,WARMSKIP
        call    FLUSH
        jp      nz,BOOTERR
WARMSKIP:
        inc     c
        jr      WRMFLUSH
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

; Boot failure is terminal: print the error line and halt with interrupts off.
; In: any failed boot stage; no caller resumes. Clobbers AF/HL; stack use is
; one two-byte PRINTZ return word. Already completed checkpoints remain durable.
BOOTERR:
        ld      hl,BOOTMSG
        call    PRINTZ
        halt
        jr      BOOTERR

; Install the conventional warm-boot and BDOS jump vectors in page zero.
; In: selected profile constants. Out: 0000 and 0005 contain JP instructions.
; Clobbers A/HL; flags and other registers preserved; stack balanced.
PAGEZERO:
        ld      a,$C3
        ld      ($0000),a
        ld      hl,WarmBoot
        ld      ($0001),hl
        ld      ($0005),a
        ld      hl,BDOSENT
        ld      ($0006),hl
        ret

; In: none. Out: A=FF if console ready else 0; Z iff not ready, carry clear.
; Clobbers AF.
; Balanced stack; other registers preserved.
CONSTAT:
        in      a,(SERSTAT)
        and     1
        ret     z
        ld      a,$FF
        ret

; In: none. Out: A=7-bit character, polls until available. Clobbers AF.
; Balanced stack; other registers preserved.
CONIN:
        call    CONSTAT
        or      a
        jr      z,CONIN
        in      a,(SERDATA)
        and     $7F
        ret

; In: C=character. Out: serial write; flags unchanged. Clobbers A. Balanced
; stack; other registers preserved.
CONOUT:
        ld      a,c
        out     (SERDATA),a
        ret

; In: C=character. Out: discarded. No registers or flags changed; balanced
; stack.
LISTOUT:
; In: C=character. Out: discarded. No registers or flags changed; balanced
; stack.
PUNCHOUT:
        ret

; In: none. Out: A=1A EOF. Flags unchanged; other registers preserved; balanced
; stack.
READER:
        ld      a,$1A
        ret

; In: none. Out: CURTRACK=0. Clobbers BC; flags unchanged; balanced stack.
Home:
        ld      bc,0

; In: BC=track (validated at I/O). Out: CURTRACK stored. Registers/flags
; preserved; balanced stack.
SetTrack:
        ld      (CURTRACK),bc
        ret

; Select configured slot C, requiring exactly 16384 controller records.
; Publish CURDRIVE only after validation; rejected selects retain the last
; binding.
; In: C=drive. Out: HL=DPH or zero on absent/wrong-size/unsupported drive.
; Clobbers: AF, HL. BC/DE/IX/IY preserved. Stack balanced.
; GET_CAPACITY replaces controller address registers but performs no record
; I/O.
SELDSK:
        ld      a,c
        cp      DRIVES
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
        cp      $40
        ret     nz
        in      a,(DSKREC2)
        or      a
        ret     nz
        in      a,(DSKREC3)
        or      a
        ret     nz
        ld      a,c
        ld      (CURDRIVE),a
; DPH size is sixteen bytes, so four doublings convert the drive index to a
; byte offset. DE is saved because SELDSK must preserve the caller's login
; hint.
        ld      l,a
        ld      h,0
        add     hl,hl
        add     hl,hl
        add     hl,hl
        add     hl,hl
        push    de
        ld      de,DPHEADS
        add     hl,de
        pop     de
        ret

; In: BC=one-based sector (validated at I/O). Out: CURSECT stored.
; Registers/flags preserved; balanced stack.
SETSEC:
        ld      (CURSECT),bc
        ret

; In: BC=128-byte DMA address. Out: CURDMA stored. Registers/flags preserved;
; balanced stack.
SetDma:
        ld      (CURDMA),bc
        ret

; In: selected drive, stored track/sector/DMA. Out: A=0/Z success, 1/NZ error;
; valid read writes 128 DMA bytes. Clobbers AF/BC/DE/HL; balanced stack.
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

; In: selected drive, stored track/sector/DMA. Out: A=0/Z success including
; FLUSH, 1/NZ failure. Clobbers AF/BC/DE/HL; balanced stack; failed flush may
; follow published cache write.
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
; Commit the shared dirty cache and checkpoint the selected controller drive.
; In: DSKDRIVE already selected. Out: A=0/Z success or A=1/NZ error, carry clear.
; Clobbers AF; other registers preserved; balanced stack. Earlier cache writes
; or drive checkpoints are not undone if this checkpoint fails.
FLUSH:
        ld      a,CMDFLUSH
        out     (DSKSTAT),a
        call    WAITIDLE
        ret

; Validate before converting track/one-based sector to controller address.
; In: CURTRACK=0..127, CURSECT=1..128. Out: A=0/Z success or A=1/NZ error.
; Clobbers: AF, BC, DE, HL. Stack balanced. Invalid coordinates issue no ports.
; The last valid record is 3FFF; capacity is the separate 32-bit count
; 00004000.
SELADDR:
        ld      a,(CURDRIVE)
        cp      DRIVES
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
        or      a
        jp      nz,DISKERR
        ld      a,l
        cp      128
        jp      nc,DISKERR
; Track multiplication by 128 requires seven doublings. Validation above
; bounds the result to 3F80; adding sector-1 reaches at most 3FFF.
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

; Poll a read command until the controller offers its 128-byte transfer.
; In: READ_RECORD issued. Out: A=0/Z ready or A=1/NZ error, carry clear.
; Clobbers AF; other registers preserved; stack balanced. The controller must
; complete or report an error: this synchronous interface has no timeout.
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

; Poll a write command until the controller accepts its 128-byte transfer.
; In: WRITE_RECORD issued. Out: A=0/Z ready or A=1/NZ error, carry clear.
; Clobbers AF; other registers preserved; stack balanced; no software timeout.
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

; Check completion after exactly 128 data-port bytes have been transferred.
; In: read or write transfer consumed. Out: A=0/Z success, A=1/NZ if error or
; transfer remains active; carry clear. Clobbers AF; stack balanced.
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

; Poll a non-data command such as GET_CAPACITY or FLUSH until busy clears.
; Out: A=0/Z success or A=1/NZ controller error, carry clear. Clobbers AF;
; other registers preserved; stack balanced. Data-request status is not used.
WAITIDLE:
        in      a,(DSKSTAT)
        bit     0,a
        jr      nz,WAITIDLE
        bit     2,a
        jr      nz,DISKERR
        xor     a
        ret

; Shared BIOS error return. Out: A=1, Z clear, carry clear. Clobbers AF only.
; RET consumes the caller's existing return word; no additional stack storage.
DISKERR:
        ld      a,1
        or      a
        ret

; In: none. Out: A=0/Z, not ready. Clobbers AF; balanced stack; other registers
; preserved.
LISTSTAT:
        xor     a
        ret

; In: BC=zero-based sector. Out: HL=BC+1 (wraps 16 bits), identity translation.
; Flags unchanged; balanced stack; other registers preserved.
SECTRAN:
        ld      h,b
        ld      l,c
        inc     hl
        ret

; Print a zero-terminated byte string through the raw serial output port.
; In: HL points to readable text. Out: HL points to terminator, A=0/Z and carry
; clear. Clobbers AF/HL; other registers preserved; stack balanced.
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

DPBLOCK:
        DW      TRACKREC
        DB      4
        DB      15
        DB      0
        DW      1015
        DW      1023
        DB      $FF,$FF
        DW      0
        DW      1

DIRBUF:
        DS      128
; CKS=0: the checksum-vector pointer is unused and reserves no bytes.
; Media replacement therefore requires the host's checkpoint/restart protocol;
; there is no checksum-based live-media-change detection.
CHKSVEC:

        DS      32
BOOTSP:

COMMONND:
; A negative DS count makes ATOM reject growth beyond the common budget.
        DS      BIOSBASE+$300-$,0
DPHEADS:
; The builder appends DRIVES distinct entries, then pads to BIOSBASE+$400.
; Entry words: translation, three BDOS scratch words, directory buffer, DPB,
; checksum vector, allocation vector. The shared geometry and directory buffer
; have one address each; allocation vectors and DPH scratch words are distinct.

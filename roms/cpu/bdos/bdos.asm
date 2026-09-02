; Triptych-owned CP/M 2.2 BDOS.
;
; This source intentionally uses the common Atom/AZM subset. Names fit Atom's
; eight-character limit, and all code, data, and stack storage remain inside
; the fixed $EC00..$F9FF resident slot.

        ORG     $EC00

IOBYTE  EQU     $0003

BIOWBT  EQU     $FA03
BIOCST  EQU     $FA06
BIOCIN  EQU     $FA09
BIOCOT  EQU     $FA0C
BIOLST  EQU     $FA0F
BIOPUN  EQU     $FA12
BIORDR  EQU     $FA15
BIOHOM  EQU     $FA18
BIOSEL  EQU     $FA1B
BIOTRK  EQU     $FA1E
BIOSEC  EQU     $FA21
BIODMA  EQU     $FA24
BIORDS  EQU     $FA27
BIOWRS  EQU     $FA2A
BIOTRN  EQU     $FA30

CTRLC   EQU     3
CTRLE   EQU     5
BACKSP  EQU     8
TAB     EQU     9
LF      EQU     10
CR      EQU     13
CTRLP   EQU     16
CTRLR   EQU     18
CTRLS   EQU     19
CTRLU   EQU     21
CTRLX   EQU     24
SPACE   EQU     32
DELETE  EQU     $7F

; CP/M places its public entry six bytes into the resident BDOS extent.
        DS      6,0

BENTRY:
        LD      (OLDSP),SP
        LD      SP,STKTOP
        LD      (PARAM),DE
        LD      A,C
        CP      41
        JR      NC,RETZERO
        ADD     A,A
        LD      E,A
        LD      D,0
        LD      HL,FNTAB
        ADD     HL,DE
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        EX      DE,HL
        LD      DE,(PARAM)
        JP      (HL)

RETZERO:
        XOR     A

RETA:
        LD      L,A
        LD      H,0
        LD      B,H
        LD      SP,(OLDSP)
        RET

RETWORD:
        LD      A,L
        LD      B,H
        LD      SP,(OLDSP)
        RET

FNZERO:
        JP      BIOWBT

FNCIN:
        CALL    GETCHAR
        LD      C,A
        PUSH    AF
        CALL    ECHOCHAR
        POP     AF
        JP      RETA

FNCOUT:
        LD      A,(PARAM)
        LD      C,A
        CALL    OUTCHAR
        JP      RETZERO

FNREAD:
        CALL    BIORDR
        JP      RETA

FNPUNCH:
        LD      A,(PARAM)
        LD      C,A
        CALL    BIOPUN
        JP      RETZERO

FNLIST:
        LD      A,(PARAM)
        LD      C,A
        CALL    BIOLST
        JP      RETZERO

FNDIRECT:
        LD      A,(PARAM)
        CP      $FF
        JR      NZ,DIROUT
        CALL    CONSTAT
        OR      A
        JP      Z,RETZERO
        CALL    GETCHAR
        JP      RETA

DIROUT:
        LD      C,A
        CALL    BIOCOT
        JP      RETZERO

FNGETIO:
        LD      A,(IOBYTE)
        JP      RETA

FNSETIO:
        LD      A,(PARAM)
        LD      (IOBYTE),A
        JP      RETZERO

FNPRINT:
        LD      HL,(PARAM)

PRLOOP:
        LD      A,(HL)
        CP      '$'
        JP      Z,RETZERO
        INC     HL
        PUSH    HL
        LD      C,A
        CALL    OUTCHAR
        POP     HL
        JR      PRLOOP

FNLINE:
        LD      HL,(PARAM)
        LD      A,(HL)
        LD      (LINMAX),A
        INC     HL
        XOR     A
        LD      (HL),A
        LD      (LINCNT),A
        INC     HL
        LD      (LINPTR),HL

LINLOOP:
        CALL    GETCHAR
        LD      C,A
        CP      CR
        JP      Z,LINDONE
        CP      LF
        JP      Z,LINDONE
        CP      CTRLP
        JR      Z,LINTGL
        CP      BACKSP
        JR      Z,LINBACK
        CP      DELETE
        JR      Z,LINDEL
        CP      CTRLC
        JR      Z,LINABRT
        CP      CTRLE
        JP      Z,LINEOL
        CP      CTRLR
        JP      Z,LINRETY
        CP      CTRLU
        JP      Z,LINCTU
        CP      CTRLX
        JP      Z,LINCLEAR
        LD      A,(LINCNT)
        LD      B,A
        LD      A,(LINMAX)
        CP      B
        JP      Z,LINDONE
        LD      A,C
        LD      HL,(LINPTR)
        LD      (HL),A
        INC     HL
        LD      (LINPTR),HL
        LD      A,B
        INC     A
        LD      (LINCNT),A
        CALL    ECHOCHAR
        LD      A,(LINCNT)
        LD      B,A
        LD      A,(LINMAX)
        CP      B
        JR      NZ,LINLOOP
        LD      C,CR
        JP      LINDONE

LINTGL:
        CALL    TOGLIST
        JR      LINLOOP

LINBACK:
        LD      A,(LINCNT)
        OR      A
        JP      Z,LINLOOP
        DEC     A
        LD      (LINCNT),A
        LD      HL,(LINPTR)
        DEC     HL
        LD      (LINPTR),HL
        CALL    ERASE1
        JP      LINLOOP

LINDEL:
        LD      A,(LINCNT)
        OR      A
        JP      Z,LINLOOP
        DEC     A
        LD      (LINCNT),A
        LD      HL,(LINPTR)
        DEC     HL
        LD      (LINPTR),HL
        LD      C,(HL)
        CALL    ECHOCHAR
        JP      LINLOOP

LINABRT:
        LD      A,(LINCNT)
        OR      A
        JP      NZ,LINLOOP
        LD      HL,(LINPTR)
        LD      (HL),CTRLC
        LD      C,'^'
        CALL    ECHOCHAR
        LD      C,'C'
        CALL    ECHOCHAR
        JP      BIOWBT

LINEOL:
        LD      C,CR
        CALL    ECHOONE
        LD      C,LF
        CALL    ECHOONE
        JP      LINLOOP

LINRETY:
        LD      C,'#'
        CALL    ECHOONE
        LD      C,CR
        CALL    ECHOONE
        LD      C,LF
        CALL    ECHOONE
        LD      HL,(PARAM)
        INC     HL
        INC     HL
        LD      A,(LINCNT)
        LD      B,A

RETYLP:
        LD      A,B
        OR      A
        JP      Z,LINLOOP
        LD      C,(HL)
        PUSH    BC
        PUSH    HL
        CALL    ECHOCHAR
        POP     HL
        POP     BC
        INC     HL
        DJNZ    RETYLP
        JP      LINLOOP

LINCTU:
        LD      C,'#'
        CALL    ECHOONE
        LD      C,CR
        CALL    ECHOONE
        LD      C,LF
        CALL    ECHOONE
        XOR     A
        LD      (LINCNT),A
        LD      HL,(PARAM)
        INC     HL
        INC     HL
        LD      (LINPTR),HL
        JP      LINLOOP

LINCLEAR:
        LD      A,(LINCNT)
        OR      A
        JP      Z,LINLOOP
        CALL    ERASE1
        LD      A,(LINCNT)
        DEC     A
        LD      (LINCNT),A
        LD      HL,(LINPTR)
        DEC     HL
        LD      (LINPTR),HL
        JR      LINCLEAR

LINDONE:
        CALL    ECHOCHAR
        LD      HL,(PARAM)
        INC     HL
        LD      A,(LINCNT)
        LD      (HL),A
        JP      RETZERO

FNSTAT:
        LD      A,(PENDING)
        OR      A
        JR      NZ,STATYES
        CALL    BIOCST
        OR      A
        JP      Z,RETZERO
        CALL    BIOCIN
        LD      (PENDCHR),A
        LD      A,1
        LD      (PENDING),A

STATYES:
        LD      A,1
        JP      RETA

FNVERS:
        LD      A,$22
        JP      RETA

; Reset to drive A, restore the standard DMA address, and discover all disk
; geometry and work areas through the public BIOS DPH/DPB boundary.
FNRESET:
        XOR     A
        LD      (CURDRV),A
        LD      (USERNO),A
        LD      HL,0
        LD      (LOGINV),HL
        LD      (ROVEC),HL
        LD      HL,$0080
        LD      (CURDMA),HL
        LD      B,H
        LD      C,L
        CALL    BIODMA
        CALL    LOGIN
        JP      RETZERO

FNSEL:
        LD      A,(PARAM)
        LD      B,A
        LD      A,(CURDRV)
        CP      B
        JP      Z,RETZERO
        LD      A,B
        LD      (CURDRV),A
        CALL    LOGIN
        JP      RETZERO

; Open uses the same public-directory iterator as search, then imports only
; the directory-owned FCB fields. Bit 7 of S2 marks the FCB unmodified, which
; lets close avoid a disk write until a later mutation service changes it.
FNOPEN:
        LD      HL,(PARAM)
        LD      (SRCHFCB),HL
        LD      A,1
        LD      (OPENMOD),A
        CALL    NEWSRCH
        CALL    FINDENT
        JP      RETA

FNCLSE:
        LD      HL,(PARAM)
        LD      DE,14
        ADD     HL,DE
        LD      A,(HL)
        AND     $80
        JP      NZ,RETZERO
        LD      A,$FF
        JP      RETA

FNSRCHF:
        LD      HL,(PARAM)
        LD      (SRCHFCB),HL
        XOR     A
        LD      (OPENMOD),A
        CALL    NEWSRCH
        CALL    FINDENT
        JP      RETA

FNSRCHN:
        XOR     A
        LD      (OPENMOD),A
        CALL    FINDENT
        JP      RETA

FNREADSQ:
        CALL    READSEQ
        JP      RETA

READSEQ:
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        LD      A,(HL)
        CP      128
        JR      C,READCHK
        CALL    NEXTEXT
        OR      A
        JP      NZ,READ_EOF
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        XOR     A
        LD      (HL),A

READCHK:
        LD      A,(HL)
        LD      (SEQREC),A
        LD      B,A
        LD      HL,(PARAM)
        LD      DE,15
        ADD     HL,DE
        LD      A,(HL)
        CP      B
        JP      Z,READ_EOF
        JP      C,READ_EOF
        CALL    FCBLOCK
        LD      A,D
        OR      E
        JP      Z,READ_EOF

        EX      DE,HL
        LD      DE,(DPBPTR)
        INC     DE
        INC     DE
        LD      A,(DE)
        LD      B,A
        LD      A,B
        OR      A
        JR      Z,BLOCKSCA

BLOCKSHF:
        ADD     HL,HL
        DJNZ    BLOCKSHF

BLOCKSCA:
        LD      DE,(DPBPTR)
        INC     DE
        INC     DE
        INC     DE
        LD      A,(DE)
        LD      B,A
        LD      A,(SEQREC)
        AND     B
        LD      E,A
        LD      D,0
        ADD     HL,DE

        LD      DE,0
        LD      IX,(DPBPTR)
        LD      C,(IX+0)
        LD      B,(IX+1)

DIVTRACK:
        OR      A
        SBC     HL,BC
        JR      C,DIVDONE
        INC     DE
        JR      DIVTRACK

DIVDONE:
        ADD     HL,BC
        LD      (IOSEC),HL
        EX      DE,HL
        LD      E,(IX+13)
        LD      D,(IX+14)
        ADD     HL,DE
        LD      (IOTRK),HL

        LD      B,H
        LD      C,L
        CALL    BIOTRK
        LD      HL,(IOSEC)
        LD      B,H
        LD      C,L
        LD      DE,(XLTPTR)
        CALL    BIOTRN
        LD      B,H
        LD      C,L
        CALL    BIOSEC
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        INC     (HL)
        CALL    BIORDS
        OR      A
        CALL    NZ,BADSECT
        RET

READ_EOF:
        LD      A,1
        RET

FNRREAD:
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        LD      A,(HL)
        LD      (SAVEDCR),A
        INC     HL
        LD      C,(HL)
        INC     HL
        LD      D,(HL)
        INC     HL
        LD      E,(HL)
        LD      A,C
        AND     $7F
        LD      (SEQREC),A

        LD      A,C
        AND     $80
        RLCA
        LD      B,A
        LD      A,D
        ADD     A,A
        AND     $1E
        OR      B
        LD      (TARGEX),A

        LD      A,D
        SRL     A
        SRL     A
        SRL     A
        SRL     A
        LD      B,A
        LD      A,E
        ADD     A,A
        ADD     A,A
        ADD     A,A
        ADD     A,A
        OR      B
        AND     $3F
        LD      (TARGS2),A

        LD      HL,(PARAM)
        LD      DE,12
        ADD     HL,DE
        LD      A,(HL)
        AND     $1F
        LD      B,A
        LD      A,(TARGEX)
        CP      B
        JR      NZ,RANDOPEN
        INC     HL
        INC     HL
        LD      A,(HL)
        AND     $3F
        LD      B,A
        LD      A,(TARGS2)
        CP      B
        JR      Z,RANDPOS

RANDOPEN:
        LD      HL,(PARAM)
        LD      DE,12
        ADD     HL,DE
        LD      A,(TARGEX)
        LD      (HL),A
        INC     HL
        INC     HL
        LD      A,(HL)
        AND     $80
        LD      B,A
        LD      A,(TARGS2)
        OR      B
        LD      (HL),A
        LD      HL,(PARAM)
        LD      (SRCHFCB),HL
        LD      A,1
        LD      (OPENMOD),A
        CALL    NEWSRCH
        CALL    FINDENT
        CP      $FF
        JR      Z,RANDMISS

RANDPOS:
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        LD      A,(SEQREC)
        LD      (HL),A
        CALL    READSEQ
        PUSH    AF
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        LD      A,(SAVEDCR)
        LD      (HL),A
        POP     AF
        JP      RETA

RANDMISS:
        LD      A,1
        JP      RETA

; Locate the allocation block containing the FCB's current sequential record.
; DSM selects the public one-byte or two-byte allocation-map representation.
FCBLOCK:
        LD      A,(SEQREC)
        LD      HL,(DPBPTR)
        INC     HL
        INC     HL
        LD      B,(HL)
        LD      C,A
        LD      A,B
        OR      A
        LD      A,C
        JR      Z,BLOCKIDX

RECSHFT:
        SRL     A
        DJNZ    RECSHFT

BLOCKIDX:
        LD      C,A
        LD      HL,(DPBPTR)
        LD      DE,6
        ADD     HL,DE
        LD      A,(HL)
        OR      A
        LD      A,C
        JR      Z,BLOCKBYT
        ADD     A,A
        LD      E,A
        LD      D,0
        LD      HL,(PARAM)
        LD      BC,16
        ADD     HL,BC
        ADD     HL,DE
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        RET

BLOCKBYT:
        LD      E,A
        LD      D,0
        LD      HL,(PARAM)
        LD      BC,16
        ADD     HL,BC
        ADD     HL,DE
        LD      E,(HL)
        LD      D,0
        RET

NEXTEXT:
        LD      HL,(PARAM)
        LD      DE,12
        ADD     HL,DE
        LD      A,(HL)
        INC     A
        AND     $1F
        LD      (HL),A
        JR      NZ,NEXTFIND
        INC     HL
        INC     HL
        LD      A,(HL)
        LD      B,A
        AND     $3F
        INC     A
        AND     $3F
        LD      C,A
        LD      A,B
        AND     $80
        OR      C
        LD      (HL),A

NEXTFIND:
        LD      HL,(PARAM)
        LD      (SRCHFCB),HL
        LD      A,1
        LD      (OPENMOD),A
        CALL    NEWSRCH
        CALL    FINDENT
        CP      $FF
        JR      Z,NEXTMISS
        XOR     A
        RET

NEXTMISS:
        LD      A,1
        RET

FNLOGIN:
        LD      HL,(LOGINV)
        JP      RETWORD

FNCURDSK:
        LD      A,(CURDRV)
        JP      RETA

FNSETDMA:
        LD      HL,(PARAM)
        LD      (CURDMA),HL
        LD      B,H
        LD      C,L
        CALL    BIODMA
        JP      RETZERO

FNGETALV:
        LD      HL,(ALVPTR)
        JP      RETWORD

FNWRPROT:
        CALL    DRVMASK
        EX      DE,HL
        LD      HL,(ROVEC)
        LD      A,L
        OR      E
        LD      L,A
        LD      A,H
        OR      D
        LD      H,A
        LD      (ROVEC),HL
        JP      RETZERO

FNGETRO:
        LD      HL,(ROVEC)
        JP      RETWORD

FNGETDPB:
        LD      HL,(DPBPTR)
        JP      RETWORD

FNUSER:
        LD      A,(PARAM)
        CP      $FF
        JR      Z,GETUSER
        LD      (USERNO),A
        JP      RETZERO

GETUSER:
        LD      A,(USERNO)
        JP      RETA

; Compute the highest logical record boundary across every matching extent.
; Function 35 returns $FF like CP/M while publishing the 24-bit result in the
; FCB random-record field.
FNSIZE:
        LD      HL,(PARAM)
        LD      (SRCHFCB),HL
        LD      A,2
        LD      (OPENMOD),A
        XOR     A
        LD      (FSIZE0),A
        LD      (FSIZE1),A
        LD      (FSIZE2),A
        CALL    NEWSRCH

SIZELOOP:
        CALL    FINDENT
        CP      $FF
        JR      Z,SIZEDONE
        LD      HL,(MATCHPTR)
        LD      DE,12
        ADD     HL,DE
        LD      A,(HL)
        AND     $1F
        LD      C,A
        INC     HL
        INC     HL
        LD      A,(HL)
        AND     $3F
        LD      H,0
        LD      L,A
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        LD      E,C
        LD      D,0
        ADD     HL,DE
        XOR     A
        LD      B,7

SIZESHFT:
        ADD     HL,HL
        RLA
        DJNZ    SIZESHFT
        LD      (CAND0),HL
        LD      (CAND2),A
        LD      HL,(MATCHPTR)
        LD      DE,15
        ADD     HL,DE
        LD      E,(HL)
        LD      D,0
        LD      HL,(CAND0)
        ADD     HL,DE
        LD      (CAND0),HL
        LD      A,(CAND2)
        ADC     A,0
        LD      (CAND2),A

        LD      B,A
        LD      A,(FSIZE2)
        CP      B
        JR      C,SIZEKEEP
        JR      NZ,SIZELOOP
        LD      A,(CAND1)
        LD      B,A
        LD      A,(FSIZE1)
        CP      B
        JR      C,SIZEKEEP
        JR      NZ,SIZELOOP
        LD      A,(CAND0)
        LD      B,A
        LD      A,(FSIZE0)
        CP      B
        JR      NC,SIZELOOP

SIZEKEEP:
        LD      HL,(CAND0)
        LD      (FSIZE0),HL
        LD      A,(CAND2)
        LD      (FSIZE2),A
        JR      SIZELOOP

SIZEDONE:
        LD      HL,(PARAM)
        LD      DE,33
        ADD     HL,DE
        LD      A,(FSIZE0)
        LD      (HL),A
        INC     HL
        LD      A,(FSIZE1)
        LD      (HL),A
        INC     HL
        LD      A,(FSIZE2)
        LD      (HL),A
        LD      A,$FF
        JP      RETA

; Convert the sequential EX/S2/CR position to the public 24-bit random record.
FNSETRR:
        LD      HL,(PARAM)
        LD      DE,12
        ADD     HL,DE
        LD      A,(HL)
        AND     $1F
        LD      C,A
        INC     HL
        INC     HL
        LD      A,(HL)
        AND     $3F
        LD      H,0
        LD      L,A
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        LD      E,C
        LD      D,0
        ADD     HL,DE
        XOR     A
        LD      B,7

RRSHIFT:
        ADD     HL,HL
        RLA
        DJNZ    RRSHIFT
        LD      (CAND0),HL
        LD      (CAND2),A
        LD      HL,(PARAM)
        LD      DE,32
        ADD     HL,DE
        LD      E,(HL)
        LD      D,0
        LD      HL,(CAND0)
        ADD     HL,DE
        LD      (CAND0),HL
        LD      A,(CAND2)
        ADC     A,0
        LD      (CAND2),A
        LD      HL,(PARAM)
        LD      DE,33
        ADD     HL,DE
        LD      A,(CAND0)
        LD      (HL),A
        INC     HL
        LD      A,(CAND1)
        LD      (HL),A
        INC     HL
        LD      A,(CAND2)
        LD      (HL),A
        JP      RETZERO

FNRESETD:
        LD      DE,(PARAM)
        LD      A,E
        CPL
        LD      C,A
        LD      A,D
        CPL
        LD      B,A
        LD      HL,(LOGINV)
        LD      A,L
        AND     C
        LD      L,A
        LD      A,H
        AND     B
        LD      H,A
        LD      (LOGINV),HL
        LD      HL,(ROVEC)
        LD      A,L
        AND     C
        LD      L,A
        LD      A,H
        AND     B
        LD      H,A
        LD      (ROVEC),HL
        JP      RETZERO

NEWSRCH:
        LD      HL,0
        LD      (SRCHIDX),HL
        CALL    BIOHOM
        LD      HL,(DPBPTR)
        LD      BC,13
        ADD     HL,BC
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        LD      (CURTRK),DE
        LD      HL,0
        LD      (CURSEC),HL
        RET

; Return the next matching directory slot (0..3), or $FF. Search copies the
; containing 128-byte directory record to the caller's DMA; open instead
; copies directory fields 12..31 into the supplied FCB.
FINDENT:
        LD      HL,(SRCHIDX)
        LD      DE,(DIRUSED)
        OR      A
        SBC     HL,DE
        JR      NC,NOENTRY
        LD      HL,(SRCHIDX)
        LD      A,L
        AND     3
        CALL    Z,READDIR

        LD      HL,(SRCHIDX)
        LD      A,L
        AND     3
        LD      (RETCODE),A
        ADD     A,A
        ADD     A,A
        ADD     A,A
        ADD     A,A
        ADD     A,A
        LD      E,A
        LD      D,0
        LD      HL,(DIRPTR)
        ADD     HL,DE
        LD      (MATCHPTR),HL
        CALL    MATCHFCB
        OR      A
        JR      NZ,FOUNDIT
        LD      HL,(SRCHIDX)
        INC     HL
        LD      (SRCHIDX),HL
        JR      FINDENT

FOUNDIT:
        LD      HL,(SRCHIDX)
        INC     HL
        LD      (SRCHIDX),HL
        LD      A,(OPENMOD)
        OR      A
        JR      NZ,OPENHIT
        LD      HL,(DIRPTR)
        LD      DE,(CURDMA)
        LD      BC,128
        LDIR
        LD      A,(RETCODE)
        RET

OPENHIT:
        CP      1
        JR      NZ,NOCOPY
        LD      HL,(MATCHPTR)
        LD      DE,12
        ADD     HL,DE
        LD      DE,(SRCHFCB)
        EX      DE,HL
        LD      BC,12
        ADD     HL,BC
        EX      DE,HL
        LD      BC,20
        LDIR
        LD      HL,(SRCHFCB)
        LD      DE,14
        ADD     HL,DE
        LD      A,(HL)
        OR      $80
        LD      (HL),A
        LD      A,(RETCODE)
        RET

NOCOPY:
        LD      A,(RETCODE)
        RET

NOENTRY:
        LD      A,$FF
        RET

; Match the current user and 8.3 name. Question marks in the FCB are
; single-character wildcards. Directory attribute bits are not name bits.
; Open also requires the requested logical extent.
MATCHFCB:
        LD      A,(USERNO)
        LD      B,A
        LD      A,(HL)
        CP      B
        JR      NZ,NOMATCH
        INC     HL
        LD      DE,(SRCHFCB)
        INC     DE
        LD      B,11

NAMELOOP:
        LD      A,(DE)
        CP      '?'
        JR      Z,NAMEOK
        LD      C,A
        LD      A,(HL)
        AND     $7F
        CP      C
        JR      NZ,NOMATCH

NAMEOK:
        INC     HL
        INC     DE
        DJNZ    NAMELOOP
        LD      A,(OPENMOD)
        CP      2
        JR      Z,ISMATCH
        LD      A,(DE)
        CP      '?'
        JR      Z,ISMATCH
        AND     $1F
        LD      C,A
        LD      A,(HL)
        AND     $1F
        CP      C
        JR      NZ,NOMATCH
        INC     HL
        INC     HL
        INC     DE
        INC     DE
        LD      A,(DE)
        AND     $3F
        LD      C,A
        LD      A,(HL)
        AND     $3F
        CP      C
        JR      NZ,NOMATCH

ISMATCH:
        LD      A,1
        RET

NOMATCH:
        XOR     A
        RET

READDIR:
        LD      HL,(CURTRK)
        LD      B,H
        LD      C,L
        CALL    BIOTRK
        LD      HL,(CURSEC)
        LD      B,H
        LD      C,L
        LD      DE,(XLTPTR)
        CALL    BIOTRN
        LD      B,H
        LD      C,L
        CALL    BIOSEC
        LD      HL,(DIRPTR)
        LD      B,H
        LD      C,L
        CALL    BIODMA
        CALL    BIORDS
        PUSH    AF
        LD      HL,(CURDMA)
        LD      B,H
        LD      C,L
        CALL    BIODMA
        POP     AF
        OR      A
        JP      NZ,RDFAIL
        CALL    ADVSEC
        RET

ADVSEC:
        LD      HL,(CURSEC)
        INC     HL
        EX      DE,HL
        LD      HL,(DPBPTR)
        LD      C,(HL)
        INC     HL
        LD      B,(HL)
        EX      DE,HL
        OR      A
        SBC     HL,BC
        JR      C,SECSAME
        LD      HL,0
        LD      (CURSEC),HL
        LD      HL,(CURTRK)
        INC     HL
        LD      (CURTRK),HL
        RET

SECSAME:
        ADD     HL,BC
        LD      (CURSEC),HL
        RET

; Select the current drive, capture its public tables, initialize its
; allocation vector, and reconstruct allocations from directory records.
LOGIN:
        LD      A,(CURDRV)
        LD      C,A
        LD      E,0
        CALL    BIOSEL
        LD      A,H
        OR      L
        JP      Z,SELFAIL
        LD      (DPHPTR),HL

        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        LD      (XLTPTR),DE

        LD      HL,(DPHPTR)
        LD      BC,8
        ADD     HL,BC
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        LD      (DIRPTR),DE
        INC     HL
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        LD      (DPBPTR),DE
        INC     HL
        INC     HL
        INC     HL
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        LD      (ALVPTR),DE

        CALL    DRVMASK
        EX      DE,HL
        LD      HL,(LOGINV)
        LD      A,L
        OR      E
        LD      L,A
        LD      A,H
        OR      D
        LD      H,A
        LD      (LOGINV),HL

        CALL    INITALV
        CALL    BIOHOM
        LD      HL,0
        LD      (DIRCNT),HL
        LD      (DIRUSED),HL

        LD      HL,(DPBPTR)
        LD      BC,7
        ADD     HL,BC
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        EX      DE,HL
        SRL     H
        RR      L
        SRL     H
        RR      L
        INC     HL
        LD      (DIRLEFT),HL

        LD      HL,(DPBPTR)
        LD      BC,13
        ADD     HL,BC
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        LD      (CURTRK),DE
        LD      HL,0
        LD      (CURSEC),HL

DIRSCAN:
        LD      HL,(DIRLEFT)
        LD      A,H
        OR      L
        RET     Z
        LD      HL,(CURTRK)
        LD      B,H
        LD      C,L
        CALL    BIOTRK
        LD      HL,(CURSEC)
        LD      B,H
        LD      C,L
        LD      DE,(XLTPTR)
        CALL    BIOTRN
        LD      B,H
        LD      C,L
        CALL    BIOSEC
        LD      HL,(DIRPTR)
        LD      B,H
        LD      C,L
        CALL    BIODMA
        CALL    BIORDS
        PUSH    AF
        LD      HL,(CURDMA)
        LD      B,H
        LD      C,L
        CALL    BIODMA
        POP     AF
        OR      A
        JP      NZ,RDFAIL
        CALL    PARDIR

        LD      HL,(DIRLEFT)
        DEC     HL
        LD      (DIRLEFT),HL
        CALL    ADVSEC
        JR      DIRSCAN

; Clear the BIOS-owned allocation vector and copy the reserved-directory
; bits supplied by the selected drive's DPB.
INITALV:
        LD      HL,(DPBPTR)
        LD      BC,5
        ADD     HL,BC
        LD      C,(HL)
        INC     HL
        LD      B,(HL)
        SRL     B
        RR      C
        SRL     B
        RR      C
        SRL     B
        RR      C
        INC     BC
        LD      HL,(ALVPTR)
        XOR     A

CLRAVL:
        LD      (HL),A
        INC     HL
        DEC     BC
        PUSH    AF
        LD      A,B
        OR      C
        LD      D,A
        POP     AF
        JR      NZ,CLRAVL

        LD      HL,(DPBPTR)
        LD      BC,9
        ADD     HL,BC
        LD      DE,(ALVPTR)
        LD      A,(HL)
        LD      (DE),A
        INC     HL
        INC     DE
        LD      A,(HL)
        LD      (DE),A
        RET

PARDIR:
        LD      HL,(DIRPTR)
        LD      (ENTPTR),HL
        LD      A,4
        LD      (ENTLEFT),A

PARELOOP:
        CALL    PARENT
        LD      A,(ENTLEFT)
        DEC     A
        LD      (ENTLEFT),A
        JR      NZ,PARELOOP
        RET

PARENT:
        LD      HL,(ENTPTR)
        PUSH    HL
        LD      DE,32
        ADD     HL,DE
        LD      (ENTPTR),HL
        POP     HL
        LD      DE,(DIRCNT)
        INC     DE
        LD      (DIRCNT),DE
        LD      A,(HL)
        CP      $E5
        RET     Z
        LD      (DIRUSED),DE
        LD      DE,16
        ADD     HL,DE
        LD      DE,(DPBPTR)
        INC     DE
        INC     DE
        INC     DE
        INC     DE
        INC     DE
        INC     DE
        LD      A,(DE)
        OR      A
        JR      NZ,PARWORD
        LD      A,16
        LD      (ALLEFT),A

PARBYTE:
        LD      E,(HL)
        LD      D,0
        INC     HL
        PUSH    HL
        CALL    MARKBLK
        POP     HL
        LD      A,(ALLEFT)
        DEC     A
        LD      (ALLEFT),A
        JR      NZ,PARBYTE
        RET

PARWORD:
        LD      A,8
        LD      (ALLEFT),A

PARWLOOP:
        LD      E,(HL)
        INC     HL
        LD      D,(HL)
        INC     HL
        PUSH    HL
        CALL    MARKBLK
        POP     HL
        LD      A,(ALLEFT)
        DEC     A
        LD      (ALLEFT),A
        JR      NZ,PARWLOOP
        RET

MARKBLK:
        LD      A,D
        OR      E
        RET     Z
        LD      A,E
        AND     7
        LD      B,A
        EX      DE,HL
        SRL     H
        RR      L
        SRL     H
        RR      L
        SRL     H
        RR      L
        LD      DE,(ALVPTR)
        ADD     HL,DE
        LD      A,$80
        LD      C,A
        LD      A,B
        OR      A
        LD      A,C
        JR      Z,SETABIT

SHIFBIT:
        RRCA
        DJNZ    SHIFBIT

SETABIT:
        OR      (HL)
        LD      (HL),A
        RET

DRVMASK:
        LD      A,(CURDRV)
        LD      B,A
        LD      HL,1
        LD      A,B
        OR      A
        RET     Z

MASKLOOP:
        ADD     HL,HL
        DJNZ    MASKLOOP
        RET

; Failure diagnostics are deliberately kept behind one routine so later
; milestones can add the exact CP/M retry/abort interaction without coupling
; normal disk algorithms to console policy.
SELFAIL:
        LD      HL,ERRHEAD
        CALL    ERRTEXT
        LD      A,(CURDRV)
        ADD     A,'A'
        LD      C,A
        CALL    OUTCHAR
        LD      HL,ERRSEL
        CALL    ERRTEXT
        CALL    GETCHAR
        JP      BIOWBT

ERRTEXT:
        LD      A,(HL)
        OR      A
        RET     Z
        INC     HL
        PUSH    HL
        LD      C,A
        CALL    OUTCHAR
        POP     HL
        JR      ERRTEXT

RDFAIL:
        JP      BIOWBT

BADSECT:
        LD      HL,ERRHEAD
        CALL    ERRTEXT
        LD      A,(CURDRV)
        ADD     A,'A'
        LD      C,A
        CALL    OUTCHAR
        LD      HL,ERRBAD
        CALL    ERRTEXT
        CALL    GETCHAR
        XOR     A
        RET

GETCHAR:
        LD      A,(PENDING)
        OR      A
        JP      Z,BIOCIN
        XOR     A
        LD      (PENDING),A
        LD      A,(PENDCHR)
        RET

CONSTAT:
        LD      A,(PENDING)
        OR      A
        RET     NZ
        JP      BIOCST

OUTCHAR:
        LD      A,C
        CP      TAB
        JR      NZ,OUTONE

TABLOOP:
        LD      C,SPACE
        CALL    OUTONE
        LD      A,(COLUMN)
        AND     7
        JR      NZ,TABLOOP
        RET

OUTONE:
        PUSH    BC
        CALL    CHKKEY
        POP     BC
        JR      ECHORAW

ECHOONE:
        PUSH    BC
        CALL    CONSTAT
        POP     BC

ECHORAW:
        CALL    BIOCOT
        LD      A,(LISTEN)
        OR      A
        CALL    NZ,BIOLST
        LD      A,C
        CP      CR
        JR      Z,COLZERO
        CP      BACKSP
        JR      Z,COLBACK
        CP      SPACE
        RET     C
        LD      A,(COLUMN)
        INC     A
        LD      (COLUMN),A
        RET

ECHOCHAR:
        LD      A,C
        CP      TAB
        JR      NZ,ECHOONE

ECHOTAB:
        LD      C,SPACE
        CALL    ECHOONE
        LD      A,(COLUMN)
        AND     7
        JR      NZ,ECHOTAB
        RET

COLZERO:
        XOR     A
        LD      (COLUMN),A
        RET

COLBACK:
        LD      A,(COLUMN)
        OR      A
        RET     Z
        DEC     A
        LD      (COLUMN),A
        RET

CHKKEY:
        CALL    CONSTAT
        OR      A
        RET     Z
        CALL    GETCHAR
        CP      CTRLS
        JR      NZ,CHKPRN
        CALL    GETCHAR
        RET

CHKPRN:
        CP      CTRLP
        RET     NZ

TOGLIST:
        LD      A,(LISTEN)
        XOR     1
        LD      (LISTEN),A
        RET

ERASE1:
        LD      C,BACKSP
        CALL    BIOCOT
        LD      C,SPACE
        CALL    BIOCOT
        LD      C,BACKSP
        CALL    BIOCOT
        JP      COLBACK

FNTAB:
        DW      FNZERO,FNCIN,FNCOUT,FNREAD,FNPUNCH,FNLIST,FNDIRECT
        DW      FNGETIO,FNSETIO,FNPRINT,FNLINE,FNSTAT,FNVERS
        DW      FNRESET,FNSEL,FNOPEN,FNCLSE,FNSRCHF,FNSRCHN,RETZERO
        DW      FNREADSQ,RETZERO,RETZERO,RETZERO,FNLOGIN,FNCURDSK,FNSETDMA
        DW      FNGETALV,FNWRPROT,FNGETRO,RETZERO,FNGETDPB,FNUSER
        DW      FNRREAD,RETZERO,FNSIZE,FNSETRR,FNRESETD,RETZERO
        DW      RETZERO,RETZERO

OLDSP:  DW      0
PARAM:  DW      0
COLUMN: DB      0
LISTEN: DB      0
PENDING: DB      0
PENDCHR: DB      0
LINPTR: DW      0
LINMAX: DB      0
LINCNT: DB      0
CURDRV: DB      0
USERNO: DB      0
LOGINV: DW      0
ROVEC:  DW      0
CURDMA: DW      $0080
DPHPTR: DW      0
DPBPTR: DW      0
DIRPTR: DW      0
ALVPTR: DW      0
XLTPTR: DW      0
CURTRK: DW      0
CURSEC: DW      0
DIRLEFT: DW     0
ENTPTR: DW      0
ENTLEFT: DB     0
ALLEFT: DB      0
DIRCNT: DW      0
DIRUSED: DW     0
SRCHIDX: DW     0
SRCHFCB: DW     0
MATCHPTR: DW    0
OPENMOD: DB     0
RETCODE: DB     0
SEQREC: DB      0
IOTRK:  DW      0
IOSEC:  DW      0
FSIZE0: DB      0
FSIZE1: DB      0
FSIZE2: DB      0
CAND0:  DB      0
CAND1:  DB      0
CAND2:  DB      0
SAVEDCR: DB     0
TARGEX: DB      0
TARGS2: DB      0
ERRHEAD: DB     CR,LF,"Bdos Err On ",0
ERRSEL: DB      ": Select",0
ERRBAD: DB      ": Bad Sector",0

STKBASE:
        DS      64,0
STKTOP:

        DS      $FA00-$,0

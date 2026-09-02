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
        CP      13
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

FNZERO:
        JP      BIOWBT

FNCIN:
        CALL    GETCHAR
        LD      C,A
        PUSH    AF
        CALL    OUTCHAR
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
        CALL    OUTCHAR
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
        CALL    OUTCHAR
        JP      LINLOOP

LINABRT:
        LD      A,(LINCNT)
        OR      A
        JP      NZ,LINLOOP
        LD      HL,(LINPTR)
        LD      (HL),CTRLC
        LD      C,'^'
        CALL    OUTCHAR
        LD      C,'C'
        CALL    OUTCHAR
        JP      BIOWBT

LINEOL:
        LD      C,CR
        CALL    OUTONE
        LD      C,LF
        CALL    OUTONE
        JP      LINLOOP

LINRETY:
        LD      C,'#'
        CALL    OUTONE
        LD      C,CR
        CALL    OUTONE
        LD      C,LF
        CALL    OUTONE
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
        CALL    OUTCHAR
        POP     HL
        POP     BC
        INC     HL
        DJNZ    RETYLP
        JP      LINLOOP

LINCTU:
        LD      C,'#'
        CALL    OUTONE
        LD      C,CR
        CALL    OUTONE
        LD      C,LF
        CALL    OUTONE
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
        CALL    OUTCHAR
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

OLDSP:  DW      0
PARAM:  DW      0
COLUMN: DB      0
LISTEN: DB      0
PENDING: DB      0
PENDCHR: DB      0
LINPTR: DW      0
LINMAX: DB      0
LINCNT: DB      0

STKBASE:
        DS      64,0
STKTOP:

        DS      $FA00-$,0

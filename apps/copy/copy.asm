; COPY.COM — a small CP/M transient for one source and one destination.
;
; Public command:
;     COPY source destination
;
; The source precedes the destination, as in the familiar MS-DOS command.
; This first profile deliberately has no wildcards, concatenation, prompting,
; or directory traversal. It copies CP/M logical 128-byte records through the
; public BDOS FCB interface and refuses to replace an existing file.
;
; Entry: CP/M loads the program at $0100 and supplies the command tail at
;        $0080. The incoming stack contains the warm-boot return address.
; Exit:  ordinary paths restore that stack and return to CP/M CCP.

        ORG     $0100

BDOS    EQU     $0005
CMDLEN  EQU     $0080
CMDTXT  EQU     $0081

OPENFN  EQU     15
CLOSEFN EQU     16
DELFN   EQU     19
READFN  EQU     20
WRITEFN EQU     21
MAKEFN  EQU     22
DMAFN   EQU     26
PRTFN   EQU     9

CR      EQU     13
LF      EQU     10
SPACE   EQU     ' '

START:
        LD      (ENTRYSP),SP
        LD      SP,STACKTOP
        CALL    PTAIL
        JP      C,HELP
        CALL    FILES
        JP      C,ERRHDL
        LD      DE,DONE
        CALL    PRTSTR
        JP      RETCP

; Parse exactly two unambiguous 8.3 names. The parser returns carry for an
; empty name, a wildcard, a malformed drive prefix, an overlong field, an
; unsupported delimiter, or an extra operand.
PTAIL:
        LD      A,(CMDLEN)
        OR      A
        JR      Z,BADTAIL
        CP      128
        JR      NC,BADTAIL
        LD      B,A
        LD      HL,CMDTXT
        LD      DE,TAILBUF
TCOPY:
        LD      A,(HL)
        LD      (DE),A
        INC     HL
        INC     DE
        DJNZ    TCOPY
        XOR     A
        LD      (DE),A

        LD      HL,TAILBUF
        CALL    SKIP
        LD      DE,SRCFCB
        CALL    PFCB
        RET     C
        CALL    SKIP
        LD      A,(HL)
        OR      A
        JR      Z,BADTAIL
        LD      DE,DSTFCB
        CALL    PFCB
        RET     C
        CALL    SKIP
        LD      A,(HL)
        OR      A
        JR      NZ,BADTAIL
        XOR     A
        RET

BADTAIL:
        SCF
        RET

; Skip ordinary command separators. HL returns at the next non-space byte.
SKIP:
        LD      A,(HL)
        CP      SPACE
        RET     NZ
        INC     HL
        JR      SKIP

; Initialise a complete FCB, then parse one token at HL into DE. The drive
; byte is zero for the current drive or one through sixteen for A: through P:.
PFCB:
        PUSH    HL
        CALL    CLRFCB
        POP     HL
        LD      A,(HL)
        CP      'A'
        JR      C,PSTART
        CP      'P'+1
        JR      NC,PSTART
        LD      B,A
        INC     HL
        LD      A,(HL)
        CP      ':'
        JR      NZ,NOBACK
        LD      A,B
        SUB     'A'-1
        LD      (DE),A
        INC     HL
        JR      PSTART
NOBACK:
        DEC     HL

PSTART:
        PUSH    DE
        INC     DE
        XOR     A
        LD      (SEEN),A
        LD      B,8

NLOOP:
        LD      A,(HL)
        OR      A
        JR      Z,NEND
        CP      SPACE
        JR      Z,NEND
        CP      '.'
        JR      Z,NDOT
        CALL    VALID
        JR      C,BADPOP
        LD      (DE),A
        LD      A,1
        LD      (SEEN),A
        INC     DE
        INC     HL
        DJNZ    NLOOP
        ; Eight name bytes are full; only a delimiter is legal now.
        LD      A,(HL)
        OR      A
        JR      Z,NEND
        CP      SPACE
        JR      Z,NEND
        CP      '.'
        JR      Z,NDOT
        JR      BADPOP

NDOT:
        LD      A,(SEEN)
        OR      A
        JR      Z,BADPOP
        INC     HL
        POP     DE
        PUSH    DE
        EX      DE,HL
        LD      BC,9
        ADD     HL,BC
        EX      DE,HL
        LD      B,3
        XOR     A
        LD      (SEEN),A

ELOOP:
        LD      A,(HL)
        OR      A
        JR      Z,EEND
        CP      SPACE
        JR      Z,EEND
        CP      '.'
        JR      Z,BADPOP
        CALL    VALID
        JR      C,BADPOP
        LD      (DE),A
        LD      A,1
        LD      (SEEN),A
        INC     DE
        INC     HL
        DJNZ    ELOOP
        LD      A,(HL)
        OR      A
        JR      Z,EEND
        CP      SPACE
        JR      Z,EEND
        JR      BADPOP

NEND:
        LD      A,(SEEN)
        OR      A
        JR      Z,BADPOP
        POP     DE
        XOR     A
        RET

EEND:
        LD      A,(SEEN)
        OR      A
        JR      Z,BADPOP
        POP     DE
        XOR     A
        RET

BADPOP:
        POP     DE
        SCF
        RET

; The first profile accepts ordinary visible CP/M filename characters but
; rejects grammar delimiters and wildcards. CCP has already uppercased input.
VALID:
        CP      '!'
        JR      C,BADCHAR
        CP      $7F
        JR      NC,BADCHAR
        CP      ':'
        JR      Z,BADCHAR
        CP      '='
        JR      Z,BADCHAR
        CP      '*'
        JR      Z,BADCHAR
        CP      '?'
        JR      Z,BADCHAR
        CP      '/'
        JR      Z,BADCHAR
        CP      $5C
        JR      Z,BADCHAR
        CP      ';'
        JR      Z,BADCHAR
        CP      ','
        JR      Z,BADCHAR
        CP      '<'
        JR      Z,BADCHAR
        CP      '>'
        JR      Z,BADCHAR
        CP      '['
        JR      Z,BADCHAR
        CP      ']'
        JR      Z,BADCHAR
        OR      A
        RET

BADCHAR:
        SCF
        RET

; Clear a complete FCB, then restore spaces in its name and type fields.
CLRFCB:
        PUSH    DE
        XOR     A
        LD      B,36
CLRL:
        LD      (DE),A
        INC     DE
        DJNZ    CLRL
        POP     HL
        PUSH    HL
        INC     HL
        LD      A,SPACE
        LD      B,11
SPACES:
        LD      (HL),A
        INC     HL
        DJNZ    SPACES
        POP     DE
        RET

; Compare source and destination identity fields before touching BDOS.
SAME:
        LD      HL,SRCFCB
        LD      DE,DSTFCB
        LD      B,12
CMPL:
        LD      A,(DE)
        CP      (HL)
        JR      NZ,CMPBAD
        INC     DE
        INC     HL
        DJNZ    CMPL
        XOR     A
        RET

CMPBAD:
        LD      A,1
        OR      A
        RET

; Copy records through the public BDOS interface. A nonzero status becomes
; carry after best-effort close/delete cleanup.
FILES:
        CALL    SAME
        JP      Z,IOFAIL

        LD      DE,SRCFCB
        LD      C,OPENFN
        CALL    CPBDOS
        INC     A
        JR      Z,SRCMISS

        LD      DE,DSTFCB
        LD      C,OPENFN
        CALL    CPBDOS
        INC     A
        JR      Z,DSTFREE
        LD      DE,DSTFCB
        LD      C,CLOSEFN
        CALL    CPBDOS
        LD      DE,SRCFCB
        LD      C,CLOSEFN
        CALL    CPBDOS
        JR      DSTEX

DSTFREE:
        CALL    RSTTAIL
        LD      DE,DSTFCB
        LD      C,MAKEFN
        CALL    CPBDOS
        INC     A
        JR      Z,SRCCLS

        LD      DE,DMABUF
        LD      C,DMAFN
        CALL    CPBDOS

RLOOP:
        LD      DE,SRCFCB
        LD      C,READFN
        CALL    CPBDOS
        OR      A
        JR      Z,WREC
        CP      1
        JR      Z,FINISH
        JR      PARTFAIL

WREC:
        LD      DE,DSTFCB
        LD      C,WRITEFN
        CALL    CPBDOS
        OR      A
        JR      NZ,PARTFAIL
        JR      RLOOP

FINISH:
        LD      DE,DSTFCB
        LD      C,CLOSEFN
        CALL    CPBDOS
        INC     A
        JR      Z,PARTFAIL
        LD      DE,SRCFCB
        LD      C,CLOSEFN
        CALL    CPBDOS
        INC     A
        JR      Z,PARTFAIL
        XOR     A
        RET

SRCMISS:
        LD      A,1
        SCF
        RET

DSTEX:
        LD      A,2
        SCF
        RET

SRCCLS:
        LD      DE,SRCFCB
        LD      C,CLOSEFN
        CALL    CPBDOS
        JR      IOFAIL

PARTFAIL:
        LD      DE,DSTFCB
        LD      C,CLOSEFN
        CALL    CPBDOS
        CALL    DELDST
        LD      DE,SRCFCB
        LD      C,CLOSEFN
        CALL    CPBDOS

IOFAIL:
        LD      A,3
        SCF
        RET

DELDST:
        CALL    RSTTAIL
        LD      DE,DSTFCB
        LD      C,DELFN
        CALL    CPBDOS
        RET

; A fresh make/delete must see a clean tail; identity bytes remain intact.
RSTTAIL:
        PUSH    DE
        LD      DE,DSTFCB+12
        XOR     A
        LD      B,24
RSTL:
        LD      (DE),A
        INC     DE
        DJNZ    RSTL
        POP     DE
        RET

; Preserve the index pairs even though the public BDOS contract only promises
; the 8080 register set.
CPBDOS:
        PUSH    IX
        PUSH    IY
        CALL    BDOS
        POP     IY
        POP     IX
        RET

PRTSTR:
        LD      C,PRTFN
        JP      CPBDOS

HELP:
        LD      DE,USETXT
        CALL    PRTSTR
        JP      RETCP

ERRHDL:
        CP      1
        JR      Z,SRCERR
        CP      2
        JR      Z,DSTERR
        LD      DE,IOTEXT
        JR      ERRPRT

SRCERR:
        LD      DE,SRCTXT
        JR      ERRPRT

DSTERR:
        LD      DE,DSTTXT

ERRPRT:
        CALL    PRTSTR
        JP      RETCP

RETCP:
        LD      SP,(ENTRYSP)
        RET

USETXT:
        DB      "COPY source destination",CR,LF,'$'
SRCTXT:
        DB      "COPY: source not found",CR,LF,'$'
DSTTXT:
        DB      "COPY: destination exists",CR,LF,'$'
IOTEXT:
        DB      "COPY: disk error",CR,LF,'$'
DONE:
        DB      "1 file copied",CR,LF,'$'

; CP/M's file control block is 36 bytes. The first twelve bytes are the
; command identity; BDOS owns the extent, record and allocation fields.
SRCFCB:
        DS      36,0
DSTFCB:
        DS      36,0
DMABUF:
        DS      128,0
TAILBUF:
        DS      128,0
ENTRYSP:
        DS      2,0
SEEN:
        DS      1,0
STACK:
        DS      64,0
STACKTOP:
        DS      1,0

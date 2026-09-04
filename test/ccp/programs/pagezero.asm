; Public-boundary probe for CCP command-tail, default-FCB, and return setup.

        ORG     $0100

BDOS    EQU     $0005
CURDSK  EQU     $0004
FCBONE  EQU     $005C
FCBTWO  EQU     $006C
CMDTAIL EQU     $0080
CR      EQU     13
LF      EQU     10

        LD      DE,DRVTEXT
        CALL    PRINT
        LD      A,(CURDSK)
        CALL    HEXBYTE
        CALL    NEWLINE

        LD      DE,TAILTXT
        CALL    PRINT
        LD      A,(CMDTAIL)
        CALL    HEXBYTE
        LD      A,':'
        CALL    PUTCHAR
        LD      A,(CMDTAIL)
        LD      B,A
        LD      HL,CMDTAIL+1

TAILLOOP:
        LD      A,B
        OR      A
        JR      Z,TAILEND
        LD      A,(HL)
        CALL    PUTCHAR
        INC     HL
        DEC     B
        JR      TAILLOOP

TAILEND:
        CALL    NEWLINE
        LD      DE,TERMTXT
        CALL    PRINT
        LD      A,(CMDTAIL)
        LD      E,A
        LD      D,0
        LD      HL,CMDTAIL+1
        ADD     HL,DE
        LD      A,(HL)
        CALL    HEXBYTE
        CALL    NEWLINE

        LD      DE,FCB1TXT
        CALL    PRINT
        LD      HL,FCBONE
        CALL    SHOWFCB
        LD      DE,FCB2TXT
        CALL    PRINT
        LD      HL,FCBTWO
        CALL    SHOWFCB

        LD      DE,RETTEXT
        CALL    PRINT
        RET

SHOWFCB:
        LD      A,(HL)
        CALL    HEXBYTE
        LD      A,'|'
        CALL    PUTCHAR
        INC     HL
        LD      B,8
        CALL    PUTN
        LD      A,'|'
        CALL    PUTCHAR
        LD      B,3
        CALL    PUTN
        JP      NEWLINE

PUTN:
        LD      A,(HL)
        CALL    PUTCHAR
        INC     HL
        DJNZ    PUTN
        RET

HEXBYTE:
        PUSH    AF
        RRCA
        RRCA
        RRCA
        RRCA
        CALL    HEXDIG
        POP     AF

HEXDIG:
        AND     $0F
        ADD     A,'0'
        CP      58              ; '9'+1
        JR      C,PUTCHAR
        ADD     A,7             ; 'A'-'9'-1

PUTCHAR:
        PUSH    BC
        PUSH    DE
        PUSH    HL
        LD      E,A
        LD      C,2
        CALL    BDOS
        POP     HL
        POP     DE
        POP     BC
        RET

PRINT:
        LD      C,9
        JP      BDOS

NEWLINE:
        LD      DE,CRLFTXT
        JP      PRINT

DRVTEXT:
        DB      "DRIVE=","$"
TAILTXT:
        DB      "TAIL=","$"
TERMTXT:
        DB      "TERM=","$"
FCB1TXT:
        DB      "FCB1=","$"
FCB2TXT:
        DB      "FCB2=","$"
RETTEXT:
        DB      "RETURN",CR,LF,"$"
CRLFTXT:
        DB      CR,LF,"$"

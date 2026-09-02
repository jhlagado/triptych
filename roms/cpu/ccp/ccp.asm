; Triptych-owned CP/M 2.2 Console Command Processor.
;
; This is an independent implementation against the public CP/M interfaces
; and Triptych's black-box CCP fixtures. It intentionally uses the common
; Atom/AZM subset and owns no state outside $E400..$EBFF while resident.

        ORG     $E400

BDOS    EQU     $0005
WBOOT   EQU     $0000
CURDSK  EQU     $0004
FCBONE  EQU     $005C
FCBTWO  EQU     $006C
CMDTAIL EQU     $0080
TPA     EQU     $0100
BDOSBAS EQU     $EC00

CR      EQU     13
LF      EQU     10
SPACE   EQU     32

; Cold and warm boot both enter here with C holding the current drive. The
; freshly loaded BDOS has no live disk state, so rebuild it before prompting.
CCPENT:
        LD      SP,STKTOP
        LD      A,C
        LD      (BOOTDRV),A
        LD      C,13
        CALL    BDOS
        LD      A,(BOOTDRV)
        OR      A
        JR      Z,STARTED
        LD      E,A
        LD      C,14
        CALL    BDOS

STARTED:
        LD      DE,CRLFMSG
        CALL    PUTSTR

MAINLOOP:
        LD      SP,STKTOP
        LD      C,25
        CALL    BDOS
        LD      (CURDSK),A
        ADD     A,'A'
        LD      E,A
        CALL    PUTCHAR
        LD      E,'>'
        CALL    PUTCHAR
        LD      DE,CMDBUF
        LD      C,10
        CALL    BDOS
        LD      DE,CRLFMSG
        CALL    PUTSTR

        LD      A,(CMDLEN)
        OR      A
        JR      Z,MAINLOOP
        LD      B,A
        LD      HL,CMDTXT

UPLOOP:
        LD      A,(HL)
        CP      'a'
        JR      C,UPNEXT
        CP      'z'+1
        JR      NC,UPNEXT
        AND     $DF
        LD      (HL),A

UPNEXT:
        INC     HL
        DJNZ    UPLOOP
        XOR     A
        LD      (HL),A

        LD      HL,CMDTXT
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JR      Z,MAINLOOP
        CP      'A'
        JR      C,NOTDRIVE
        CP      'P'+1
        JR      NC,NOTDRIVE
        LD      B,A
        INC     HL
        LD      A,(HL)
        CP      ':'
        JR      NZ,NOTDRIVE
        INC     HL
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JR      NZ,NOTDRIVE
        LD      A,B
        SUB     'A'
        LD      (BOOTDRV),A
        LD      E,A
        LD      C,14
        CALL    BDOS
        LD      A,(BOOTDRV)
        LD      (CURDSK),A
        JP      MAINLOOP

NOTDRIVE:
        LD      HL,CMDTXT
        CALL    SKIPSP
        LD      (CMDSTRT),HL
        LD      DE,CMDFCB
        CALL    PARSEFCB
        LD      (ARGSTRT),HL
        LD      DE,DIRKEY
        CALL    ISCMD
        JP      Z,CMDDIR
        LD      DE,TYPEKEY
        CALL    ISCMD
        JP      Z,CMDTYPE
        LD      A,'C'
        LD      (CMDFCB+9),A
        LD      A,'O'
        LD      (CMDFCB+10),A
        LD      A,'M'
        LD      (CMDFCB+11),A
        CALL    LOADCOM
        JR      C,BADCMD
        CALL    PREPPAGE
        LD      SP,TPA
        LD      HL,WBOOT
        PUSH    HL
        JP      TPA

BADCMD:
        LD      HL,(CMDSTRT)

BADLOOP:
        LD      A,(HL)
        OR      A
        JR      Z,BADEND
        CP      SPACE
        JR      Z,BADEND
        LD      E,A
        PUSH    HL
        CALL    PUTCHAR
        POP     HL
        INC     HL
        JR      BADLOOP

BADEND:
        LD      E,'?'
        CALL    PUTCHAR
        LD      DE,CRLFMSG
        CALL    PUTSTR
        JP      STARTED

; Load an ordinary COM image through the public BDOS FCB/DMA interface.
; Carry reports missing, unreadable, or oversized input.
LOADCOM:
        LD      DE,CMDFCB
        LD      C,15
        CALL    BDOS
        INC     A
        SCF
        RET     Z
        LD      HL,TPA

LOADLOOP:
        LD      A,H
        CP      BDOSBAS/256
        JR      Z,LOADLIM
        PUSH    HL
        EX      DE,HL
        LD      C,26
        CALL    BDOS
        LD      DE,CMDFCB
        LD      C,20
        CALL    BDOS
        POP     HL
        OR      A
        JR      NZ,LOADEND
        LD      DE,128
        ADD     HL,DE
        JR      LOADLOOP

; One scratch read distinguishes an exact-TPA image from an oversized image
; without allowing a further record to overwrite the resident CCP.
LOADLIM:
        PUSH    HL
        LD      DE,LOADBUF
        LD      C,26
        CALL    BDOS
        LD      DE,CMDFCB
        LD      C,20
        CALL    BDOS
        POP     HL
        CP      1
        JR      Z,LOADOK
        SCF
        RET

LOADEND:
        CP      1
        JR      NZ,LOADBAD

LOADOK:
        LD      DE,CMDFCB
        LD      C,16
        CALL    BDOS
        OR      A
        RET

LOADBAD:
        SCF
        RET

; DIR uses only search-first/search-next and the public DMA directory record.
CMDDIR:
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      DE,CMDFCB
        CALL    PARSEFCB
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JR      NZ,DIRREADY
        LD      HL,CMDFCB+1
        LD      B,11
        LD      A,'?'

DIRWILD:
        LD      (HL),A
        INC     HL
        DJNZ    DIRWILD

DIRREADY:
        LD      DE,LOADBUF
        LD      C,26
        CALL    BDOS
        XOR     A
        LD      (DIRCOL),A
        LD      (DIRANY),A
        LD      DE,CMDFCB
        LD      C,17
        CALL    BDOS

DIRLOOP:
        INC     A
        JR      Z,DIRDONE
        DEC     A
        LD      L,A
        LD      H,0
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,HL
        LD      DE,LOADBUF
        ADD     HL,DE
        PUSH    HL
        LD      DE,10
        ADD     HL,DE
        BIT     7,(HL)
        POP     HL
        JR      NZ,DIRNEXT
        LD      (DIRENTP),HL

        LD      A,(DIRCOL)
        OR      A
        JR      Z,DIRHEAD
        LD      DE,DIRSEP
        CALL    PUTSTR
        JR      DIRNAME

DIRHEAD:
        LD      A,(DIRANY)
        OR      A
        JR      Z,DIRPREF
        LD      DE,CRLFMSG
        CALL    PUTSTR

DIRPREF:
        LD      A,(CURDSK)
        ADD     A,'A'
        LD      E,A
        CALL    PUTCHAR
        LD      DE,DIRDRV
        CALL    PUTSTR

DIRNAME:
        LD      HL,(DIRENTP)
        LD      A,1
        LD      (DIRANY),A
        INC     HL
        LD      B,8
        CALL    PUTNAME
        LD      E,SPACE
        PUSH    HL
        CALL    PUTCHAR
        POP     HL
        LD      B,3
        CALL    PUTNAME
        LD      A,(DIRCOL)
        INC     A
        AND     3
        LD      (DIRCOL),A

DIRNEXT:
        LD      DE,CMDFCB
        LD      C,18
        CALL    BDOS
        JR      DIRLOOP

DIRDONE:
        LD      A,(DIRANY)
        OR      A
        JR      NZ,DIRNL
        LD      DE,NOFILE
        CALL    PUTSTR

DIRNL:
        JP      STARTED

PUTNAME:
        LD      A,(HL)
        AND     $7F
        LD      E,A
        PUSH    BC
        PUSH    HL
        CALL    PUTCHAR
        POP     HL
        POP     BC
        INC     HL
        DJNZ    PUTNAME
        RET

; TYPE streams public 128-byte records and stops at CP/M text EOF.
CMDTYPE:
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JR      Z,TYPENO
        LD      DE,CMDFCB
        CALL    PARSEFCB
        LD      DE,CMDFCB
        LD      C,15
        CALL    BDOS
        INC     A
        JR      Z,TYPENO
        LD      DE,LOADBUF
        LD      C,26
        CALL    BDOS

TYPEREAD:
        LD      DE,CMDFCB
        LD      C,20
        CALL    BDOS
        OR      A
        JR      NZ,TYPEEND
        LD      HL,LOADBUF
        LD      B,128

TYPEBYTE:
        LD      A,(HL)
        CP      $1A
        JR      Z,TYPEEND
        LD      E,A
        PUSH    BC
        PUSH    HL
        CALL    PUTCHAR
        POP     HL
        POP     BC
        INC     HL
        DJNZ    TYPEBYTE
        JR      TYPEREAD

TYPEEND:
        LD      DE,CMDFCB
        LD      C,16
        CALL    BDOS
        JP      STARTED

TYPENO:
        LD      DE,NOFILE
        CALL    PUTSTR
        JP      STARTED

; Publish only documented page-zero transient state after loading succeeds.
PREPPAGE:
        LD      HL,(ARGSTRT)
        PUSH    HL
        CALL    SKIPSP
        LD      DE,FCBONE
        CALL    PARSEFCB
        CALL    SKIPSP
        LD      DE,FCBTWO
        CALL    PARSEFCB
        POP     HL

        LD      DE,CMDTAIL+1
        LD      B,0

TAILLOOP:
        LD      A,(HL)
        OR      A
        JR      Z,TAILDONE
        LD      (DE),A
        INC     HL
        INC     DE
        INC     B
        JR      TAILLOOP

TAILDONE:
        LD      A,B
        LD      (CMDTAIL),A
        XOR     A
        LD      (DE),A
        LD      DE,CMDTAIL
        LD      C,26
        CALL    BDOS
        RET

; Parse one CP/M file reference into the first 16 bytes of an FCB. HL points
; at the first token byte and returns at its delimiter. A '*' expands to '?'
; through the remainder of its current field.
PARSEFCB:
        LD      (FCBBASE),DE
        PUSH    HL
        PUSH    DE
        XOR     A
        LD      (DE),A
        INC     DE
        LD      B,11
        LD      A,SPACE

FCBSPACE:
        LD      (DE),A
        INC     DE
        DJNZ    FCBSPACE
        XOR     A
        LD      B,4

FCBZERO:
        LD      (DE),A
        INC     DE
        DJNZ    FCBZERO
        POP     DE
        POP     HL

        LD      A,(HL)
        OR      A
        RET     Z
        INC     HL
        LD      A,(HL)
        DEC     HL
        CP      ':'
        JR      NZ,FCBNAME
        LD      A,(HL)
        SUB     'A'-1
        LD      (DE),A
        INC     HL
        INC     HL

FCBNAME:
        INC     DE
        LD      B,8
        CALL    PARFLD
        LD      A,(HL)
        CP      '.'
        RET     NZ
        INC     HL
        PUSH    HL
        LD      HL,(FCBBASE)
        LD      DE,9
        ADD     HL,DE
        EX      DE,HL
        POP     HL
        LD      B,3
        JP      PARFLD

PARFLD:
        LD      A,(HL)
        OR      A
        RET     Z
        CP      SPACE
        RET     Z
        CP      '.'
        RET     Z
        CP      '*'
        JR      Z,PARSTAR
        LD      (DE),A
        INC     DE
        INC     HL
        DJNZ    PARFLD

PARSKIP:
        LD      A,(HL)
        OR      A
        RET     Z
        CP      SPACE
        RET     Z
        CP      '.'
        RET     Z
        INC     HL
        JR      PARSKIP

PARSTAR:
        LD      A,'?'

STARLOOP:
        LD      (DE),A
        INC     DE
        DJNZ    STARLOOP
        INC     HL
        JR      PARSKIP

SKIPSP:
        LD      A,(HL)
        CP      SPACE
        RET     NZ
        INC     HL
        JR      SKIPSP

; Compare the parsed command word with a zero-terminated keyword. Equality
; requires a command delimiter or end immediately after the keyword.
ISCMD:
        LD      HL,(CMDSTRT)

KEYLOOP:
        LD      A,(DE)
        OR      A
        JR      Z,KEYEND
        CP      (HL)
        RET     NZ
        INC     DE
        INC     HL
        JR      KEYLOOP

KEYEND:
        LD      A,(HL)
        OR      A
        RET     Z
        CP      SPACE
        RET

PUTSTR:
        LD      C,9
        JP      BDOS

PUTCHAR:
        LD      C,2
        JP      BDOS

CRLFMSG:
        DB      CR,LF,'$'
DIRSEP:
        DB      ' : ','$'
DIRDRV:
        DB      ': ','$'
NOFILE:
        DB      'NO FILE','$'
DIRKEY:
        DB      'DIR',0
TYPEKEY:
        DB      'TYPE',0

CMDFCB:
        DS      36,0
CMDBUF:
        DB      127
CMDLEN:
        DB      0
CMDTXT:
        DS      128,0
BOOTDRV:
        DB      0
CMDSTRT:
        DW      0
ARGSTRT:
        DW      0
FCBBASE:
        DW      0
DIRCOL:
        DB      0
DIRANY:
        DB      0
DIRENTP:
        DW      0

; This is both the oversize discriminator and ordinary CCP scratch storage.
LOADBUF:
        DS      128,0

STKBASE:
        DS      48,0
STKTOP:

        DS      $EC00-$,0

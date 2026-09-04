; Triptych-owned CP/M 2.2 Console Command Processor.
;
; This is an independent implementation against the public CP/M interfaces
; and Triptych's black-box CCP fixtures. ATOM is its assembler, and it owns no
; state outside $E400..$EBFF while resident.

        ORG     $E400

BDOS    EQU     $0005
WBOOT   EQU     $0000
CURDSK  EQU     $0004
FCBONE  EQU     $005C
FCBTWO  EQU     $006C
CMDTAIL EQU     $0080
TPA     EQU     $0100
CCPBAS  EQU     $E400

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

        LD      A,(CMDLEN)
        OR      A
        JP      Z,STARTED
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
        JP      Z,STARTED
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
        JP      STARTED

NOTDRIVE:
        LD      DE,CRLFMSG
        CALL    PUTSTR
        LD      HL,CMDTXT
        CALL    SKIPSP
        LD      (CMDSTRT),HL
        LD      DE,CMDFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        LD      (ARGSTRT),HL
        LD      DE,DIRKEY
        CALL    ISCMD
        JP      Z,CMDDIR
        LD      DE,TYPEKEY
        CALL    ISCMD
        JP      Z,CMDTYPE
        LD      DE,ERAKEY
        CALL    ISCMD
        JP      Z,CMDERA
        LD      DE,RENKEY
        CALL    ISCMD
        JP      Z,CMDREN
        LD      DE,SAVEKEY
        CALL    ISCMD
        JP      Z,CMDSAVE
        LD      DE,USERKEY
        CALL    ISCMD
        JP      Z,CMDUSER
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
        CP      CCPBAS/256
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
        LD      (CMDSTRT),HL
        LD      DE,CMDFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      NZ,BADCMD
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
        LD      (CMDSTRT),HL
        LD      A,(HL)
        OR      A
        JR      Z,TYPENO
        LD      DE,CMDFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      NZ,BADCMD
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

; ERA deletes through BDOS only after the complete operand has parsed.
CMDERA:
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      (CMDSTRT),HL
        LD      A,(HL)
        OR      A
        JP      Z,BADCMD
        LD      DE,CMDFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      NZ,BADCMD
        XOR     A
        LD      (ERAALL),A
        LD      HL,CMDFCB+1
        LD      B,11

ERACHK:
        LD      A,(HL)
        CP      '?'
        JR      NZ,ERADEL
        INC     HL
        DJNZ    ERACHK
        LD      DE,ALLQUERY
        CALL    PUTSTR
        LD      C,1
        CALL    BDOS
        AND     $DF
        LD      (ERAANS),A

ERADRAIN:
        LD      C,1
        CALL    BDOS
        CP      CR
        JR      NZ,ERADRAIN
        LD      A,(ERAANS)
        CP      'Y'
        JP      NZ,STARTED
        LD      A,1
        LD      (ERAALL),A

ERADEL:
        LD      DE,CMDFCB
        LD      C,19
        CALL    BDOS
        INC     A
        JR      Z,ERANO
        LD      A,(ERAALL)
        OR      A
        JP      NZ,STARTED
        JP      MAINLOOP

ERANO:
        LD      DE,NOFILE
        CALL    PUTSTR
        JP      STARTED

; REN's public syntax is NEW=OLD. A separate destination FCB permits an
; existence check before the function-23 mutation FCB is assembled.
CMDREN:
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      (CMDSTRT),HL
        LD      A,(HL)
        OR      A
        JP      Z,BADCMD
        LD      DE,RENFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        LD      A,(HL)
        CP      '='
        JP      NZ,BADCMD
        INC     HL
        LD      A,(HL)
        OR      A
        JP      Z,BADCMD
        LD      DE,CMDFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      NZ,BADCMD

        LD      DE,LOADBUF
        LD      C,26
        CALL    BDOS
        LD      DE,RENFCB
        LD      C,17
        CALL    BDOS
        INC     A
        JR      NZ,RENEXIST

        LD      HL,RENFCB
        LD      DE,CMDFCB+16
        LD      BC,12
        LDIR
        LD      DE,CMDFCB
        LD      C,23
        CALL    BDOS
        INC     A
        JR      Z,ERANO
        JP      MAINLOOP

RENEXIST:
        LD      DE,FILEEX
        CALL    PUTSTR
        JP      STARTED

; USER accepts one decimal user number in the CP/M 2.2 range 0..15.
CMDUSER:
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      (CMDSTRT),HL
        LD      A,(HL)
        CP      '0'
        JP      C,BADCMD
        CP      '9'+1
        JP      NC,BADCMD
        SUB     '0'
        LD      B,A
        INC     HL
        LD      A,(HL)
        CP      '0'
        JR      C,USERDONE
        CP      '9'+1
        JR      NC,USERDONE
        LD      A,B
        CP      1
        JP      NZ,BADCMD
        LD      A,(HL)
        CP      '6'
        JP      NC,BADCMD
        SUB     '0'-10
        LD      B,A
        INC     HL

USERDONE:
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      NZ,BADCMD
        LD      E,B
        LD      C,32
        CALL    BDOS
        JP      MAINLOOP

; SAVE writes 256-byte pages from the TPA. The Triptych profile rejects a
; count beyond the 227 pages ending at $E3FF instead of reading resident code.
CMDSAVE:
        LD      HL,(ARGSTRT)
        CALL    SKIPSP
        LD      (CMDSTRT),HL
        LD      A,(HL)
        CP      '0'
        JP      C,BADCMD
        CP      '9'+1
        JP      NC,BADCMD
        LD      B,0

SAVENUM:
        LD      A,(HL)
        CP      '0'
        JR      C,SAVENEND
        CP      '9'+1
        JR      NC,SAVENEND
        SUB     '0'
        LD      E,A
        LD      A,B
        ADD     A,A
        JP      C,BADCMD
        LD      D,A
        ADD     A,A
        ADD     A,A
        ADD     A,D
        JP      C,BADCMD
        ADD     A,E
        JP      C,BADCMD
        LD      B,A
        INC     HL
        JR      SAVENUM

SAVENEND:
        CP      SPACE
        JP      NZ,BADCMD
        LD      A,B
        CP      228
        JP      NC,BADCMD
        LD      (SAVEPGS),A
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      Z,BADCMD
        LD      DE,CMDFCB
        CALL    PARSEFCB
        JP      C,BADCMD
        CALL    SKIPSP
        LD      A,(HL)
        OR      A
        JP      NZ,BADCMD

        LD      DE,CMDFCB
        LD      C,19
        CALL    BDOS
        LD      DE,CMDFCB
        LD      C,22
        CALL    BDOS
        INC     A
        JR      Z,SAVENOSP
        LD      HL,TPA
        LD      (SAVEADR),HL

SAVELOOP:
        LD      A,(SAVEPGS)
        OR      A
        JR      Z,SAVECLS
        CALL    SAVE128
        JR      C,SAVENOSP
        CALL    SAVE128
        JR      C,SAVENOSP
        LD      A,(SAVEPGS)
        DEC     A
        LD      (SAVEPGS),A
        JR      SAVELOOP

SAVE128:
        LD      DE,(SAVEADR)
        LD      C,26
        CALL    BDOS
        LD      DE,CMDFCB
        LD      C,21
        CALL    BDOS
        OR      A
        SCF
        RET     NZ
        LD      HL,(SAVEADR)
        LD      DE,128
        ADD     HL,DE
        LD      (SAVEADR),HL
        OR      A
        RET

SAVECLS:
        LD      DE,CMDFCB
        LD      C,16
        CALL    BDOS
        INC     A
        JR      Z,SAVENOSP
        JP      MAINLOOP

SAVENOSP:
        LD      DE,NOSPACE
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
        ; A parsed FCB is reusable command state, so reset the complete tail:
        ; EX/S1/S2/RC, the allocation map, CR, and the random-record fields.
        ; Leaving CR behind makes the command after TYPE begin loading at
        ; record one rather than at the start of its COM file.
        LD      B,24

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
        CP      'A'
        JR      C,FCBDRBAD
        CP      'Q'
        JR      NC,FCBDRBAD
        SUB     'A'-1
        LD      (DE),A
        INC     HL
        INC     HL

FCBNAME:
        INC     DE
        LD      B,8
        CALL    PARFLD
        RET     C
        LD      A,(HL)
        CP      '.'
        JR      Z,FCBDOT
        OR      A
        RET

FCBDOT:
        INC     HL
        PUSH    HL
        LD      HL,(FCBBASE)
        LD      DE,9
        ADD     HL,DE
        EX      DE,HL
        POP     HL
        LD      B,3
        JP      PARFLD

FCBDRBAD:
        SCF
        RET

PARFLD:
        LD      A,(HL)
        OR      A
        RET     Z
        CP      SPACE
        RET     Z
        CP      '='
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
        CP      '='
        RET     Z
        CP      '.'
        RET     Z

PARLONG:
        INC     HL
        LD      A,(HL)
        OR      A
        JP      Z,PLEND
        CP      SPACE
        JP      Z,PLEND
        CP      '='
        JP      Z,PLEND
        CP      '.'
        JR      NZ,PARLONG

PLEND:
        SCF
        RET

PARSTAR:
        LD      A,'?'

STARLOOP:
        LD      (DE),A
        INC     DE
        DJNZ    STARLOOP
        INC     HL

PARIGN:
        LD      A,(HL)
        OR      A
        RET     Z
        CP      SPACE
        RET     Z
        CP      '='
        RET     Z
        CP      '.'
        RET     Z
        INC     HL
        JR      PARIGN

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
        DB      " : ",'$'
DIRDRV:
        DB      ": ",'$'
NOFILE:
        DB      "NO FILE",'$'
DIRKEY:
        DB      "DIR",0
TYPEKEY:
        DB      "TYPE",0
ERAKEY:
        DB      "ERA",0
RENKEY:
        DB      "REN",0
SAVEKEY:
        DB      "SAVE",0
USERKEY:
        DB      "USER",0
FILEEX:
        DB      "FILE EXISTS",'$'
NOSPACE:
        DB      "NO SPACE",'$'
ALLQUERY:
        DB      "ALL (Y/N)?",'$'

CMDFCB:
        DS      36,0
RENFCB:
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
SAVEPGS:
        DB      0
SAVEADR:
        DW      0
ERAANS:
        DB      0
ERAALL:
        DB      0

; This is both the oversize discriminator and ordinary CCP scratch storage.
LOADBUF:
        DS      128,0

STKBASE:
        DS      48,0
STKTOP:

        DS      $EC00-$,0

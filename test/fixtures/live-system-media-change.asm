; ATOM guarded-A COM proof. Entry0100, private FCB/DMA/stack belowN4TPA.
; A initially contains this program and sentinelO; host replaces it with dataA.
; Close/flush before both host boundaries; BDOS37 resets A login after swap.
; Clobbers AF/BC/DE/HL/flags. Private stack remains live until JP0 warmboot.
ORG $0100
entry:
    LD SP,stk_end
    LD DE,dma
    LD C,26
    CALL 5
    CALL readsent
    LD A,(dma)
    CP 'O'
    JP NZ,fail
    CALL flush_a
    LD DE,prompt
    CALL print
    LD C,1
    CALL 5
cont:
    ; Closed FCBs and explicit reset relinquish A's old login/allocation state.
    LD DE,1
    LD C,37
    CALL 5
    LD HL,fcb+12
    LD B,24
    XOR A
clearfcb:
    LD (HL),A
    INC HL
    DJNZ clearfcb
    CALL readsent
    LD A,(dma)
    CP 'N'
    JP NZ,fail
    LD DE,new_fcb
    LD C,22
    CALL 5
    CP $FF
    JP Z,fail
    LD DE,new_fcb
    LD C,21
    CALL 5
    OR A
    JP NZ,fail
    LD DE,new_fcb
    LD C,16
    CALL 5
    CP $FF
    JP Z,fail
    CALL flush_a
    LD DE,passed
    CALL print
    LD C,1
    CALL 5
warmboot:
    JP 0

; In: FCB reset, DMA selected. Out: one record in DMA, FCB closed.
; Clobbers AF/BC/DE/HL, flags; balanced stack on success, terminal FAIL otherwise.
readsent:
    LD DE,fcb
    LD C,15
    CALL 5
    CP $FF
    JP Z,fail
    LD DE,fcb
    LD C,20
    CALL 5
    OR A
    JP NZ,fail
    LD DE,fcb
    LD C,16
    CALL 5
    CP $FF
    JP Z,fail
    RET

; In: no live transfer. Out: A checkpoint acknowledged or terminal FAIL.
; Clobbers A/flags; other registers preserved; balanced stack on success.
flush_a:
    XOR A
    OUT ($11),A
    LD A,3
    OUT ($10),A
    IN A,($17)
    OR A
    JP NZ,fail
    RET

; In: DE dollar-terminated text. Out: printed; clobbers AF/BC/DE/HL/flags.
; Balanced stack; BDOS owns output and does not touch private FCB/DMA buffers.
print:
    LD C,9
    JP 5
fail:
    LD DE,failed
    CALL print
    HALT
    JP fail
prompt: DB "LIVE A READY",13,10,'$'
passed: DB "LIVE A DATA PASS",13,10,'$'
failed: DB "LIVE FAIL",13,10,'$'
fcb: DB 1,"SENTINELTXT"
    DS 24
new_fcb: DB 1,"NEW     TXT"
    DS 24
dma: DS 128
stack: DS 128
stk_end:

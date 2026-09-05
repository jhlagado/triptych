// SPDX-License-Identifier: GPL-3.0-or-later
// Byte output shared by the adventure's main source file.
sub say(text as string[]) fails
    var i as u8
    for i = 0 until text.length
        writeOutputByte(text[i]) else fail
    end
end

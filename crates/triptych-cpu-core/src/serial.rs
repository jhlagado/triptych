use crate::Console;

#[derive(Debug, Default)]
pub(crate) struct Serial {
    lookahead: Option<u8>,
}

impl Serial {
    pub(crate) fn reset(&mut self) {
        self.lookahead = None;
    }

    fn fill(&mut self, console: &mut dyn Console) {
        if self.lookahead.is_none() {
            self.lookahead = console.receive();
        }
    }

    pub(crate) fn read_status(&mut self, console: &mut dyn Console) -> u8 {
        self.fill(console);
        0x02 | u8::from(self.lookahead.is_some())
    }

    pub(crate) fn read_data(&mut self, console: &mut dyn Console) -> u8 {
        self.fill(console);
        self.lookahead.take().unwrap_or(0)
    }
}

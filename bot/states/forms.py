from aiogram.fsm.state import State, StatesGroup


class CreateEventStates(StatesGroup):
    waiting_text = State()
    confirming = State()


class OAuthStates(StatesGroup):
    waiting = State()

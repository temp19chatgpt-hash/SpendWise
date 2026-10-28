from datetime import date, datetime
from zoneinfo import ZoneInfo
from pydantic import BaseModel, Field


def _ist_today() -> date:
    """Return today's date in IST (Asia/Kolkata) timezone."""
    return datetime.now(ZoneInfo("Asia/Kolkata")).date()


class ExpenseCreate(BaseModel):
    item: str = Field(min_length=1, max_length=100)
    amount: float = Field(ge=0)
    category: str = Field(min_length=1, max_length=50)
    expense_date: date = Field(default_factory=_ist_today)


class ExpenseUpdate(BaseModel):
    item: str | None = Field(default=None, min_length=1, max_length=100)
    amount: float | None = Field(default=None, ge=0)
    category: str | None = Field(default=None, min_length=1, max_length=50)
    expense_date: date | None = None


class ExpenseReplace(BaseModel):
    item: str = Field(min_length=1, max_length=100)
    amount: float = Field(ge=0)
    category: str = Field(min_length=1, max_length=50)
    expense_date: date


class ExpenseResponse(BaseModel):
    id: int
    item: str
    amount: float
    category: str
    expense_date: date


class PaginatedExpenseResponse(BaseModel):
    total: int | None = None
    limit: int
    offset: int
    expenses: list[ExpenseResponse]


class BudgetCreate(BaseModel):
    category: str = Field(min_length=1, max_length=50)
    monthly_limit: float = Field(gt=0)
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class BudgetResponse(BudgetCreate):
    id: int

class BudgetUpdate(BaseModel):
    monthly_limit: float | None = Field(default=None, gt=0)
import os
import json
import math
from datetime import date

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")

CATEGORIES = [
    "Grocery",
    "Outing & Eating Out",
    "Travel & Accommodation",
    "Rent & Housing",
    "Utilities & Bills",
    "Office Expense",
    "Transport",
    "Medical & Healthcare",
    "Fitness & Supplements",
    "Clothing & Footwear",
    "Shopping & Electronics",
    "Household Supplies & Maintenance",
    "Personal Care",
    "Miscellaneous",
]

client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY"),
    http_options=types.HttpOptions(
        retry_options=types.HttpRetryOptions(
            attempts=4,
            initial_delay=2.0,
            max_delay=8.0,
            exp_base=2.0,
            jitter=0.5,
            http_status_codes=[408, 429, 500, 502, 503, 504],
        )
    ),
)

async_client = client.aio


async def parse_with_gemini(message: str) -> list[dict]:
    if not message or not message.strip():
        raise ValueError("Please send a message containing expenses.")

    today = date.today().isoformat()

    prompt = f"""
You are the expense extraction engine for SpendWise.

Today's date is {today}.

Extract every expense from the user's message. Messages may contain
multiple dates and multiple expenses.

Return JSON in this structure:
{{
  "expenses": [
    {{
      "item": "Milk",
      "amount": 35,
      "category": "Grocery",
      "expense_date": "YYYY-MM-DD"
    }}
  ],
  "invalid_message": false
}}

STRICT RULES:

- Allowed categories: {json.dumps(CATEGORIES)}.
- Never create, rename, or modify a category.
- Grocery: Items bought for home consumption, including tea,
  tea powder, milk, chapati, bread, rice, flour, fruits, and vegetables.
- Outing & Eating Out: Restaurant meals, cafes, tea stalls,
  street food, and food delivery.
- Utilities & Bills: Electricity, water, gas, internet, and mobile bills.
- Office Expense: If the user explicitly specifies "Office Expense" or clearly identifies an expense as an office expense, assign this category instead of Miscellaneous. Do not use this category for general personal expenses unrelated to office work.
- Medical & Healthcare: Medicines, doctor visits, tests, and hospitals.
- Fitness & Supplements: Whey protein, creatine, and fitness supplements.
- Clothing & Footwear: Clothes, shoes, and sandals.
- Shopping & Electronics: Gadgets, appliances, and electronics.
- Miscellaneous: Expenses that do not fit another category.
- Classify based on context, not just the item name.
- Default ambiguous basic grocery items such as tea, milk, chapati,
  bread, and vegetables to Grocery.
- Use Outing & Eating Out when the message indicates a cafe,
  restaurant, tea stall, street food, or food delivery.
- Use an explicitly provided category only if it exactly matches
  an allowed category.
- Preserve item names and correct obvious spelling mistakes.
- Each expense must have an explicitly stated, clearly identifiable amount.
- Never assume a missing amount is zero.
- Never change a negative amount into a positive amount.
- If any identifiable expense has a missing, invalid, or negative amount,
  return an empty expenses list and set invalid_message to true.
- If all identifiable expenses have valid amounts, set invalid_message
  to false and return all expenses.
- Amounts must be numeric, finite, and non-negative.
- Do not invent expenses, amounts, or dates.
- Include each expense exactly once.
- Interpret date headings and relative dates using today's date.
- If no date is specified, use today.
- Dates must use YYYY-MM-DD.
- If the message contains no expenses, return an empty list and
  set invalid_message to false.
- Return JSON only, without Markdown or explanations.

USER MESSAGE:
{message}
"""

    response = await async_client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config={
            "response_mime_type": "application/json",
            "response_schema": {
                "type": "OBJECT",
                "properties": {
                    "expenses": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "item": {"type": "STRING"},
                                "amount": {"type": "NUMBER"},
                                "category": {
                                    "type": "STRING",
                                    "enum": CATEGORIES,
                                },
                                "expense_date": {"type": "STRING"},
                            },
                            "required": [
                                "item",
                                "amount",
                                "category",
                                "expense_date",
                            ],
                        },
                    },
                    "invalid_message": {"type": "BOOLEAN"},
                },
                "required": ["expenses", "invalid_message"],
            },
        },
    )

    try:
        result = json.loads(response.text)
    except (json.JSONDecodeError, TypeError):
        raise ValueError("Gemini returned an invalid response.") from None

    if not isinstance(result, dict):
        raise ValueError("Gemini returned an invalid response.")

    if result.get("invalid_message") is True:
        raise ValueError(
            "An expense has a missing, invalid, or negative amount. "
            "Please correct your message and send it again."
        )

    expenses = result.get("expenses")

    if not isinstance(expenses, list):
        raise ValueError("Gemini returned an invalid expense list.")

    for expense in expenses:
        if not isinstance(expense, dict):
            raise ValueError("Gemini returned an invalid expense.")

        item = expense.get("item")
        amount = expense.get("amount")
        category = expense.get("category")
        expense_date = expense.get("expense_date")

        if not isinstance(item, str) or not item.strip():
            raise ValueError("An expense has an invalid item name.")

        if (
            isinstance(amount, bool)
            or not isinstance(amount, (int, float))
            or not math.isfinite(amount)
            or amount < 0
        ):
            raise ValueError(
                "An expense has a missing, invalid, or negative amount."
            )

        if category not in CATEGORIES:
            raise ValueError("Gemini returned an invalid category.")

        if not isinstance(expense_date, str):
            raise ValueError("Gemini returned an invalid expense date.")

        try:
            date.fromisoformat(expense_date)
        except ValueError:
            raise ValueError(
                "Gemini returned an invalid expense date."
            ) from None

    return expenses
import os
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")

supabase: Client = create_client(url, key)
service_key = os.getenv("SUPABASE_SERVICE_KEY")

supabase_admin: Client = create_client(url, service_key)
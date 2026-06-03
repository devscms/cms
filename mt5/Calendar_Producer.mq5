//+------------------------------------------------------------------+
//|                                          Calendar_Producer.mq5     |
//|   Economic-calendar producer for the CSM app.                      |
//|   Reads MT5's NATIVE calendar (same MetaQuotes source as           |
//|   mql5.com), and pushes events to the backend via                  |
//|   WebRequest POST /api/events/ingest.                              |
//|                                                                    |
//|   Times are tagged Z exactly like CSM_Producer's ToISO(), so       |
//|   event timestamps share the SAME clock as the strength bars and   |
//|   line up on the chart with no timezone conversion.                |
//|                                                                    |
//|   Attach to ONE chart. Backfills history once, then polls a        |
//|   rolling window to capture new events + late-arriving actuals.    |
//+------------------------------------------------------------------+
#property copyright "CSM"
#property version   "1.00"
#property strict

//--- Inputs
input string ServerURL        = "https://cms.khojdex.com/api/events/ingest"; // events ingest endpoint
input string IngestToken      = "dev-token";    // must match backend INGEST_TOKEN
input int    BackfillYears     = 2;             // history to backfill on first run
input int    UpcomingDays      = 14;            // also pull this many days AHEAD
input int    PollMinutes       = 10;            // re-scan a rolling window every N minutes
input int    PollLookbackHours = 48;            // window start: now - this (catches late actuals)
input int    BatchSize         = 200;           // events per POST
input bool   DoBackfillOnStart = true;          // backfill on attach

//--- The 8 currencies the chart cares about (others ignored to keep volume sane;
//--- widen this array if you want the DB to hold the full record).
string Currencies[8] = {"USD","EUR","CHF","CAD","NZD","JPY","AUD","GBP"};

//--- State
string   g_url;
bool     g_backfilled = false;
datetime g_lastPoll   = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   g_url = ServerURL; StringReplace(g_url, "localhost", "127.0.0.1");
   PrintFormat("Calendar_Producer init. Events URL: %s", g_url);
   EventSetTimer(5);   // WebRequest is not allowed in OnInit — do work on the timer
   return(INIT_SUCCEEDED);
}
void OnDeinit(const int reason){ EventKillTimer(); }

//+------------------------------------------------------------------+
//| ISO-8601 (broker time, tagged Z) — identical to CSM_Producer.     |
//+------------------------------------------------------------------+
string ToISO(datetime t)
{
   MqlDateTime d; TimeToStruct(t,d);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",d.year,d.mon,d.day,d.hour,d.min,d.sec);
}

//+------------------------------------------------------------------+
//| POST a JSON body. Returns true on 2xx. (Same as CSM_Producer.)    |
//+------------------------------------------------------------------+
bool PostJSON(string url, string body)
{
   char data[], result[]; string rh;
   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   string headers = "Content-Type: application/json\r\nx-ingest-token: "+IngestToken+"\r\n";
   ResetLastError();
   int code = WebRequest("POST", url, headers, 10000, data, result, rh);
   if(code==-1)
   { PrintFormat("WebRequest error %d. If 4014: whitelist '%s' in Tools>Options>Expert Advisors.", GetLastError(), url); return false; }
   if(code<200||code>=300)
   { PrintFormat("HTTP %d: %s", code, CharArrayToString(result,0,WHOLE_ARRAY,CP_UTF8)); return false; }
   return true;
}

//+------------------------------------------------------------------+
//| Map MT5 importance enum → backend impact string                   |
//+------------------------------------------------------------------+
string ImpactStr(ENUM_CALENDAR_EVENT_IMPORTANCE imp)
{
   switch(imp)
   {
      case CALENDAR_IMPORTANCE_HIGH:     return "High";
      case CALENDAR_IMPORTANCE_MODERATE: return "Medium";
      case CALENDAR_IMPORTANCE_LOW:      return "Low";
      default:                            return "None";
   }
}

//+------------------------------------------------------------------+
//| A calendar value is stored ×1e6; LONG_MIN means "no value".       |
//| Emit a JSON number, or the literal null.                          |
//+------------------------------------------------------------------+
string NumField(string name, long raw)
{
   if(raw==LONG_MIN) return StringFormat("\"%s\":null", name);
   double v = (double)raw / 1000000.0;
   return StringFormat("\"%s\":%.6f", name, v);
}

//+------------------------------------------------------------------+
//| Escape the few characters that break JSON strings                 |
//+------------------------------------------------------------------+
string J(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\n", " ");
   return s;
}

//+------------------------------------------------------------------+
//| Build one event's JSON from a value + its event metadata          |
//+------------------------------------------------------------------+
string EventJSON(string currency, MqlCalendarValue &val, MqlCalendarEvent &ev)
{
   string j = "{";
   j += "\"source\":\"mt5\"";
   j += StringFormat(",\"eventId\":\"%I64u\"", val.id);          // unique per release → dedupe key
   j += StringFormat(",\"ts\":\"%s\"", ToISO(val.time));
   j += StringFormat(",\"currency\":\"%s\"", currency);
   j += StringFormat(",\"title\":\"%s\"", J(ev.name));
   j += StringFormat(",\"impact\":\"%s\"", ImpactStr(ev.importance));
   j += "," + NumField("actual",   val.actual_value);
   j += "," + NumField("forecast", val.forecast_value);
   j += "," + NumField("previous", val.prev_value);
   j += "}";
   return j;
}

//+------------------------------------------------------------------+
//| Pull [from,to] for all tracked currencies and POST in batches     |
//+------------------------------------------------------------------+
void Pull(datetime from, datetime to)
{
   int total=0, sent=0;
   string batch=""; int inBatch=0;

   for(int c=0;c<8;c++)
   {
      MqlCalendarValue values[];
      // Per-currency history. Country code NULL, currency filter set.
      int got = CalendarValueHistory(values, from, to, NULL, Currencies[c]);
      if(got<=0) continue;

      for(int i=0;i<got;i++)
      {
         MqlCalendarEvent ev;
         if(!CalendarEventById(values[i].event_id, ev)) continue;

         batch += (inBatch==0?"[":",") + EventJSON(Currencies[c], values[i], ev);
         total++;
         if(++inBatch>=BatchSize)
         { batch+="]"; if(PostJSON(g_url,batch)) sent+=inBatch; batch=""; inBatch=0; }
      }
   }
   if(inBatch>0){ batch+="]"; if(PostJSON(g_url,batch)) sent+=inBatch; }
   PrintFormat("Calendar pull [%s .. %s]: built %d, pushed %d",
               TimeToString(from), TimeToString(to), total, sent);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();

   if(DoBackfillOnStart && !g_backfilled)
   {
      g_backfilled = true;   // guard re-entry during a slow backfill
      datetime from = now - (datetime)BackfillYears*365*86400;
      datetime to   = now + (datetime)UpcomingDays*86400;
      Pull(from, to);
      g_lastPoll = now;
      Print("Calendar_Producer: backfill complete, now polling.");
      return;
   }

   if((now - g_lastPoll) >= (datetime)PollMinutes*60)
   {
      datetime from = now - (datetime)PollLookbackHours*3600;
      datetime to   = now + (datetime)UpcomingDays*86400;
      Pull(from, to);   // upserts → new events added, released actuals filled in
      g_lastPoll = now;
   }
}
//+------------------------------------------------------------------+

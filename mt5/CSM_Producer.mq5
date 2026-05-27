//+------------------------------------------------------------------+
//|                                               CSM_Producer.mq5     |
//|   Currency Strength Meter — data producer.                         |
//|   ONE instance computes all 8 currencies for H1/H4/D1 and pushes   |
//|   each closed bar to the backend via WebRequest POST /api/ingest.  |
//+------------------------------------------------------------------+
#property copyright "CSM"
#property version   "2.00"
#property strict

//--- Inputs
input string ServerURL          = "https://cms.khojdex.com/api/ingest"; // ingest endpoint
input string ClearURL           = "https://cms.khojdex.com/api/clear";  // wipe endpoint
input string IngestToken        = "dev-token";       // must match backend INGEST_TOKEN
input bool   Enable_H1          = true;              // produce H1
input bool   Enable_H4          = true;              // produce H4
input bool   Enable_D1          = true;              // produce D1
input int    EMA_Fast           = 5;                 // fast EMA period
input int    EMA_Slow           = 12;                // slow EMA period
input double SidewaysThreshold  = 0.0001;            // flat-trend deadband
input int    BackfillYears      = 2;                 // history to backfill per TF
input int    BatchSize          = 400;               // snapshots per POST
input bool   DoBackfillOnStart  = true;              // backfill history at startup
input bool   WipeBeforeBackfill = false;             // clear each TF first (first real run)
input int    LivePushSeconds    = 30;                // push current forming bar every N sec (0=off)

//--- Universe
string Currencies[8] = {"USD","EUR","CHF","CAD","NZD","JPY","AUD","GBP"};
string Pairs[28] = {
   "EURUSD","GBPUSD","AUDUSD","NZDUSD","USDJPY","USDCHF","USDCAD",
   "EURGBP","EURAUD","EURNZD","EURJPY","EURCHF","EURCAD",
   "GBPJPY","GBPCHF","GBPCAD","GBPAUD","GBPNZD",
   "AUDJPY","AUDNZD","AUDCAD","AUDCHF",
   "NZDJPY","NZDCAD","NZDCHF",
   "CADJPY","CADCHF",
   "CHFJPY"
};

//--- Timeframes handled by this single instance
ENUM_TIMEFRAMES AllTF[3]   = {PERIOD_H1, PERIOD_H4, PERIOD_D1};
string          AllLabel[3]= {"H1", "H4", "D1"};
int             BarsPerDay[3]= {24, 6, 1};
bool            tfActive[3];

//--- State
int      hFast[28][3], hSlow[28][3];   // iMA handles per (pair, tf)
bool     pairOK[28];
int      baseIdx[28], quoteIdx[28];
string   g_refSym = "EURUSD";          // reference symbol for the bar timeline
datetime g_lastBar[3];
datetime g_lastLivePush[3];
bool     g_backfilled = false;
string   g_ingestURL, g_clearURL;      // resolved URLs (localhost -> 127.0.0.1)

//+------------------------------------------------------------------+
int CurIndex(string c){ for(int i=0;i<8;i++) if(Currencies[i]==c) return i; return -1; }

//+------------------------------------------------------------------+
int OnInit()
{
   tfActive[0]=Enable_H1; tfActive[1]=Enable_H4; tfActive[2]=Enable_D1;
   if(!tfActive[0] && !tfActive[1] && !tfActive[2])
   { Print("ERROR: enable at least one timeframe."); return(INIT_PARAMETERS_INCORRECT); }

   // MT5 often rejects "localhost" in the WebRequest whitelist — normalize to 127.0.0.1
   g_ingestURL = ServerURL; StringReplace(g_ingestURL, "localhost", "127.0.0.1");
   g_clearURL  = ClearURL;  StringReplace(g_clearURL,  "localhost", "127.0.0.1");
   PrintFormat("Ingest URL resolved to: %s", g_ingestURL);

   for(int p=0;p<28;p++)
   {
      SymbolSelect(Pairs[p], true);
      baseIdx[p]  = CurIndex(StringSubstr(Pairs[p],0,3));
      quoteIdx[p] = CurIndex(StringSubstr(Pairs[p],3,3));
      pairOK[p]   = (baseIdx[p]>=0 && quoteIdx[p]>=0);
      for(int t=0;t<3;t++)
      {
         hFast[p][t]=INVALID_HANDLE; hSlow[p][t]=INVALID_HANDLE;
         if(!tfActive[t]) continue;
         hFast[p][t]=iMA(Pairs[p], AllTF[t], EMA_Fast, 0, MODE_EMA, PRICE_CLOSE);
         hSlow[p][t]=iMA(Pairs[p], AllTF[t], EMA_Slow, 0, MODE_EMA, PRICE_CLOSE);
      }
      if(!pairOK[p]) PrintFormat("WARN: pair %s currency map failed — skipped", Pairs[p]);
   }
   for(int t=0;t<3;t++) { g_lastBar[t]=0; g_lastLivePush[t]=0; }

   PrintFormat("CSM_Producer v2 init: TFs=[%s%s%s] server=%s",
               (Enable_H1?"H1 ":""),(Enable_H4?"H4 ":""),(Enable_D1?"D1":""), ServerURL);
   EventSetTimer(3);   // backfill + new-bar checks on the timer (WebRequest off OnInit)
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int p=0;p<28;p++) for(int t=0;t<3;t++)
   {
      if(hFast[p][t]!=INVALID_HANDLE) IndicatorRelease(hFast[p][t]);
      if(hSlow[p][t]!=INVALID_HANDLE) IndicatorRelease(hSlow[p][t]);
   }
}

//+------------------------------------------------------------------+
//| Trend from a single value pair: +1 up, -1 down, 0 flat            |
//+------------------------------------------------------------------+
int TrendOf(double f0,double f1,double s0,double s1)
{
   if(f0==EMPTY_VALUE||f1==EMPTY_VALUE||s0==EMPTY_VALUE||s1==EMPTY_VALUE) return 0;
   if(f0 > f1+SidewaysThreshold && s0 > s1+SidewaysThreshold) return 1;
   if(f0 < f1-SidewaysThreshold && s0 < s1-SidewaysThreshold) return -1;
   return 0;
}

//+------------------------------------------------------------------+
//| ISO-8601 timestamp (broker time, tagged Z)                        |
//+------------------------------------------------------------------+
string ToISO(datetime t)
{
   MqlDateTime d; TimeToStruct(t,d);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",d.year,d.mon,d.day,d.hour,d.min,d.sec);
}
string SnapshotJSON(int tfi, datetime t, int &vals[])
{
   string j = StringFormat("{\"tf\":\"%s\",\"ts\":\"%s\"", AllLabel[tfi], ToISO(t));
   for(int c=0;c<8;c++) j += StringFormat(",\"%s\":%d", Currencies[c], vals[c]);
   return j+"}";
}

//+------------------------------------------------------------------+
//| POST a JSON body. Returns true on 2xx.                            |
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
//| Backfill one timeframe using bulk-copied EMA buffers              |
//+------------------------------------------------------------------+
void BackfillTF(int tfi)
{
   ENUM_TIMEFRAMES tf = AllTF[tfi];
   int nBars = BackfillYears*366*BarsPerDay[tfi];
   int stride = nBars+4;

   datetime times[]; ArraySetAsSeries(times,true);
   int refGot = CopyTime(g_refSym, tf, 0, stride, times);
   if(refGot<=2){ PrintFormat("Backfill %s: not enough history (%d)", AllLabel[tfi], refGot); return; }

   if(WipeBeforeBackfill)
      if(PostJSON(g_clearURL, StringFormat("{\"tf\":\"%s\"}", AllLabel[tfi])))
         PrintFormat("Cleared existing %s data", AllLabel[tfi]);

   // Bulk-copy each pair's EMA history once (fast vs per-bar CopyBuffer).
   double fastBuf[], slowBuf[];
   ArrayResize(fastBuf, 28*stride); ArrayResize(slowBuf, 28*stride);
   ArrayInitialize(fastBuf, EMPTY_VALUE); ArrayInitialize(slowBuf, EMPTY_VALUE);
   for(int p=0;p<28;p++)
   {
      if(!pairOK[p]) continue;
      double tf1[]; ArraySetAsSeries(tf1,true);
      int g1=CopyBuffer(hFast[p][tfi],0,0,stride,tf1);
      for(int k=0;k<g1;k++) fastBuf[p*stride+k]=tf1[k];
      double ts1[]; ArraySetAsSeries(ts1,true);
      int g2=CopyBuffer(hSlow[p][tfi],0,0,stride,ts1);
      for(int k=0;k<g2;k++) slowBuf[p*stride+k]=ts1[k];
   }

   int vals[8];
   string batch=""; int inBatch=0, sent=0;
   for(int sh=refGot-1; sh>=1; sh--)   // oldest closed bar → last closed bar
   {
      datetime t = times[sh];
      for(int c=0;c<8;c++) vals[c]=0;
      for(int p=0;p<28;p++)
      {
         if(!pairOK[p]) continue;
         int ps = iBarShift(Pairs[p], tf, t, false);
         if(ps<0 || ps+1>=stride) continue;
         int idx=p*stride+ps;
         int tr = TrendOf(fastBuf[idx], fastBuf[idx+1], slowBuf[idx], slowBuf[idx+1]);
         if(tr==0) continue;
         vals[baseIdx[p]]  += tr;
         vals[quoteIdx[p]] -= tr;
      }
      batch += (inBatch==0?"[":",") + SnapshotJSON(tfi,t,vals);
      if(++inBatch>=BatchSize){ batch+="]"; if(PostJSON(g_ingestURL,batch)) sent+=inBatch; batch=""; inBatch=0; }
   }
   if(inBatch>0){ batch+="]"; if(PostJSON(g_ingestURL,batch)) sent+=inBatch; }
   PrintFormat("Backfill %s done: pushed %d snapshots", AllLabel[tfi], sent);
}

//+------------------------------------------------------------------+
//| EMA at a bar shift (single read, used for live bars)              |
//+------------------------------------------------------------------+
double EMAat(int handle,int shift)
{ double v[]; if(shift<0) return EMPTY_VALUE; if(CopyBuffer(handle,0,shift,1,v)==1) return v[0]; return EMPTY_VALUE; }

//+------------------------------------------------------------------+
//| Push one bar for a timeframe — shift=0 (live forming), shift=1 (just closed) |
//+------------------------------------------------------------------+
void PushBar(int tfi, int shift)
{
   ENUM_TIMEFRAMES tf = AllTF[tfi];
   datetime t = iTime(g_refSym, tf, shift);
   if(t<=0) return;
   int vals[8]; for(int c=0;c<8;c++) vals[c]=0;
   for(int p=0;p<28;p++)
   {
      if(!pairOK[p]) continue;
      int ps = iBarShift(Pairs[p], tf, t, false);
      if(ps<0) continue;
      int tr = TrendOf(EMAat(hFast[p][tfi],ps), EMAat(hFast[p][tfi],ps+1),
                       EMAat(hSlow[p][tfi],ps), EMAat(hSlow[p][tfi],ps+1));
      if(tr==0) continue;
      vals[baseIdx[p]]  += tr;
      vals[quoteIdx[p]] -= tr;
   }
   if(PostJSON(g_ingestURL, SnapshotJSON(tfi,t,vals)))
      PrintFormat("Pushed %s %s %s", AllLabel[tfi], (shift==0?"LIVE":"closed"), TimeToString(t));
}

//+------------------------------------------------------------------+
void OnTimer()
{
   if(DoBackfillOnStart && !g_backfilled)
   {
      g_backfilled=true;   // guard re-entry during a slow backfill
      for(int t=0;t<3;t++) if(tfActive[t]) BackfillTF(t);
      for(int t=0;t<3;t++) if(tfActive[t]) g_lastBar[t]=iTime(g_refSym, AllTF[t], 0);
      Print("CSM_Producer: backfill complete, now streaming closed bars.");
      return;
   }
   datetime now = TimeCurrent();
   for(int t=0;t<3;t++)
   {
      if(!tfActive[t]) continue;
      datetime cur = iTime(g_refSym, AllTF[t], 0);
      // closed-bar push when a new bar forms
      if(cur>0 && g_lastBar[t]!=0 && cur!=g_lastBar[t]) PushBar(t, 1);
      if(cur>0) g_lastBar[t]=cur;
      // live (forming) bar push every LivePushSeconds
      if(LivePushSeconds>0 && (now - g_lastLivePush[t]) >= LivePushSeconds)
      { PushBar(t, 0); g_lastLivePush[t] = now; }
   }
}
//+------------------------------------------------------------------+

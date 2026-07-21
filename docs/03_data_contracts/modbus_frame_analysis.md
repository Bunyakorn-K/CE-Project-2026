# 📡 Modbus Register Mapping (Laundromat Machines)

**Document Purpose:** This document defines the payload structure extracted from the local Modbus/MQTT gateway.
**CRITICAL RULE FOR AI AGENTS:** Always use these specific registers and byte ranges when writing data ingestion, parsing, or decoding logic. Do not hallucinate register addresses.

## 📊 Register Map Table

| Register Index | Byte Range | Hex     | Dec   | Description / Translation Logic (ความหมาย/แปลค่า)                                                                                                                   |
| :------------- | :--------- | :------ | :---- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0**          | `00-01`    | `00 01` | 1     | Status flag (พื้นฐาน)                                                                                                                                               |
| **1**          | `02-03`    | `27 10` | 10000 | Price: หน่วยสตางค์ (เช่น `10000` = 100.00 ฿)                                                                                                                        |
| **2**          | `04-05`    | `27 10` | 10000 | Paid: ยอดเงินที่รับแล้ว หน่วยสตางค์ (เช่น `10000` = 100.00 ฿)                                                                                                       |
| **3**          | `06-07`    | `00 02` | 2     | Program: <br>`0` = Hot<br>`1` = Warm<br>`2` = Cold                                                                                                                  |
| **4**          | `08-09`    | `00 03` | 3     | Machine State: <br>`1` = "Ready"<br>`3` = "Working"<br>อื่นๆ = State Error Code                                                                                     |
| **5**          | `10-11`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **6**          | `12-13`    | `00 00` | 0     | Minutes left (ไม่พบข้อมูลจากเครื่องรุ่นนี้)                                                                                                                         |
| **7**          | `14-15`    | `00 14` | 20    | Seconds left (เช่น `20` = เหลือเวลา 20 วินาที)                                                                                                                      |
| **8**          | `16-17`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **9**          | `18-19`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **10**         | `20-21`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **11**         | `22-23`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **12**         | `24-25`    | `00 0C` | 12    | **Physical Doors Status (Bitwise operation):**<br>`door_status = 'Close' if (val & 0b1000) else 'Open'`<br>`coinbox_status = 'Close' if (val & 0b0100) else 'Open'` |
| **13**         | `26-27`    | `00 5C` | 92    | Temperature (Fahrenheit): <br>สูตรแปลง: `(val - 32) * 5/9` (เช่น `92` $\rightarrow$ ~33.3°C)                                                                        |
| **14**         | `28-29`    | `00 DC` | 220   | _Unknown ???_                                                                                                                                                       |
| **15**         | `30-31`    | `00 12` | 18    | _Unknown ???_                                                                                                                                                       |
| **16**         | `32-33`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **17**         | `34-35`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **18**         | `36-37`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **19**         | `38-39`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **20**         | `40-41`    | `16 09` | 5641  | _Unknown ???_                                                                                                                                                       |
| **21**         | `42-43`    | `00 00` | 0     | _Unknown_                                                                                                                                                           |
| **22**         | `44-45`    | `36 2E` | 13870 | _Unknown ???_                                                                                                                                                       |
| **-**          | `46-47`    | `36 2E` | -     | **CRC (Checksum)** สำหรับตรวจสอบความสมบูรณ์ของ Payload                                                                                                              |

---

### 📝 Notes for Data Pipeline Implementation:

1. **Coin Box Estimation:** Do not rely purely on `coinbox_status` (Register 12) to reset revenue. Ensure it correlates with actual mechanical triggers or `Paid` resets as per Requirement [R07].
2. **Time Remaining:** Since Register 6 (Minutes) is missing in some models, ensure the frontend handles `Seconds left` (Register 7) appropriately, converting large seconds into `MM:SS` format.
3. **Data Types:** Treat Price and Paid as integers (Satang) during transmission and processing to avoid floating-point errors. Divide by 100 only at the Dashboard UI level.

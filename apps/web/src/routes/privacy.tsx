import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader } from "@heroui/react";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage
});

const UPDATED = "14 กันยายน 2026";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="text-sm leading-relaxed opacity-90 space-y-2">{children}</div>
    </section>
  );
}

function PrivacyPage() {
  return (
    <div className="min-h-screen flex items-start justify-center p-4 sm:p-8">
      <Card className="max-w-3xl w-full">
        <CardHeader className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">นโยบายความเป็นส่วนตัว (Privacy Policy)</h1>
          <p className="text-xs opacity-70">LaundroTwin — อัปเดตล่าสุด: {UPDATED}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <Block title="1. ข้อมูลที่เราเก็บ">
            <p>
              เราจัดเก็บข้อมูลที่จำเป็นต่อการให้บริการ ได้แก่ ข้อมูลบัญชีผู้ใช้ (ชื่อ อีเมล หรือ LINE user ID)
              ข้อมูลการให้สิทธิเข้าถึงสาขา และข้อมูลการใช้งานระบบ (บันทึกการเข้าใช้, การเรียกดูรายงาน)
              ข้อมูลเครื่องจักรและยอดขายเป็นข้อมูลของเจ้าของธุรกิจที่ได้รับอนุญาตให้เข้าถึงตามสิทธิ
            </p>
          </Block>
          <Block title="2. วัตถุประสงค์">
            <p>
              ข้อมูลถูกใช้เพื่อแสดงผลสถานะและรายงานให้ผู้มีสิทธิเท่านั้น ไม่มีการขายหรือให้เช่าข้อมูลแก่บุคคลที่สาม
              การวิเคราะห์ด้วย AI ใช้เฉพาะข้อมูลที่ผู้ใช้ได้รับอนุญาตและฟังก์ชันที่กำหนดไว้เท่านั้น
            </p>
          </Block>
          <Block title="3. การจัดเก็บและความปลอดภัย">
            <p>
              ข้อมูลถูกเก็บในเซิร์ฟเวอร์ที่เราควบคุม เข้ารหัสการเชื่อมต่อ (HTTPS) และจำกัดการเข้าถึงตามบทบาท
              กุญแจ API ที่จำเป็นถูกเข้ารหัสขณะจัดเก็บ เราเก็บ log การใช้งานตามรอบเวลาที่กำหนด (เช่น 30 วัน) แล้วลบทิ้ง
            </p>
          </Block>
          <Block title="4. สิทธิของผู้ใช้">
            <p>
              คุณสามารถขอให้เราลบหรือแก้ไขข้อมูลส่วนบุคคลของตนได้โดยติดต่อผู้ดูแลระบบ ข้อมูลที่ไม่มีสิทธิเข้าถึง
              (เช่น รายได้สาขาที่ไม่ได้รับมอบหมาย) จะถูกซ่อนไว้โดยอัตโนมัติ
            </p>
          </Block>
          <Block title="5. การติดต่อ">
            <p>
              สอบถามเรื่องความเป็นส่วนตัว: <a className="underline" href="mailto:noreply@laundrytwin.duckdns.org">noreply@laundrytwin.duckdns.org</a>
            </p>
          </Block>
          <p className="pt-2 text-sm">
            <Link to="/" className="underline">← กลับหน้าแรก</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader } from "@heroui/react";

export const Route = createFileRoute("/terms")({
  component: TermsPage
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

function TermsPage() {
  return (
    <div className="min-h-screen flex items-start justify-center p-4 sm:p-8">
      <Card className="max-w-3xl w-full">
        <CardHeader className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">ข้อกำหนดการใช้งาน (Terms of Use)</h1>
          <p className="text-xs opacity-70">LaundroTwin — อัปเดตล่าสุด: {UPDATED}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <Block title="1. บริการ">
            <p>
              LaundroTwin เป็นระบบบริหารจัดการและวิเคราะห์ร้านซักผ้าหยอดเหรียญหลายสาขา ให้บริการดูสถานะเครื่องจักร
              รายงานยอดขาย และข้อมูลวิเคราะห์ผ่านเว็บแอปพลิเคชัน ผู้ใช้ต้องมีบัญชีที่ได้รับอนุญาตจากผู้ดูแลระบบ
            </p>
          </Block>
          <Block title="2. บัญชีและการเข้าถึง">
            <p>
              บัญชีผู้ใช้เป็นสิทธิเฉพาะบุคคล ห้ามแชร์รหัสผ่านหรือให้ผู้อื่นใช้บัญชีของตน ข้อมูลที่แสดงจะถูกจำกัดตามสิทธิ
              (role) และสาขาที่ได้รับมอบหมาย เจ้าของสาขาสามารถขอเข้ากลุ่มธุรกิจได้ผ่านการอนุมัติจากผู้ดูแลระบบ
            </p>
          </Block>
          <Block title="3. ข้อมูล">
            <p>
              ข้อมูลที่แสดงในระบบมาจากเซ็นเซอร์และระบบเดิมของร้านซักผ้า (telemetry, MQTT/IRIS) และอาจมีความล่าช้า
              หรือไม่สมบูรณ์ เราไม่รับประกันความถูกต้องแบบเรียลไทม์ 100% และไม่รับผิดชอบต่อการตัดสินใจทางธุรกิจจากข้อมูลดังกล่าว
            </p>
          </Block>
          <Block title="4. ข้อจำกัดความรับผิดชอบ">
            <p>
              ข้อมูลสถานะเครื่องจักร (เช่น อุณหภูมิ แรงดัน) เป็นข้อมูลเพื่อการวิเคราะห์ ไม่ใช่ระบบเตือนภัยด้านความปลอดภัย
              ห้ามนำมาใช้ทดแทนอุปกรณ์แจ้งเตือนทางกายภาพ การคาดการณ์ใด ๆ เป็นการประมาณ ไม่ใช่การรับประกัน
            </p>
          </Block>
          <Block title="5. การติดต่อ">
            <p>
              สอบถามเพิ่มเติม: <a className="underline" href="mailto:noreply@laundrytwin.duckdns.org">noreply@laundrytwin.duckdns.org</a>
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
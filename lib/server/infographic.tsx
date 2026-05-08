import { ImageResponse } from "next/og";

export type GeneratedInfographicSection = {
  heading: string;
  bullets: string[];
};

export type GeneratedInfographicSpec = {
  headline: string;
  subtitle: string;
  sections: GeneratedInfographicSection[];
  takeaway: string;
};

type RenderParams = {
  courseName: string;
  weekLabel: string;
  spec: GeneratedInfographicSpec;
};

function truncate(value: string, maxLength: number) {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function normalizeSections(sections: GeneratedInfographicSection[]) {
  const safeSections = sections
    .slice(0, 4)
    .map((section) => ({
      heading: truncate(section.heading || "Başlık", 34),
      bullets: (section.bullets || [])
        .slice(0, 3)
        .map((bullet) => truncate(bullet || "", 92))
        .filter(Boolean),
    }))
    .filter((section) => section.bullets.length > 0);

  while (safeSections.length < 4) {
    safeSections.push({
      heading: "Öne Çıkan Nokta",
      bullets: ["Bu alan yapay zeka tarafından özet için ayrıldı."],
    });
  }

  return safeSections;
}

export async function renderInfographicPng(params: RenderParams) {
  const sections = normalizeSections(params.spec.sections);
  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(135deg, #eff6ff 0%, #ffffff 42%, #fff7ed 100%)",
          color: "#0f172a",
          padding: "40px 44px",
          fontFamily: "Georgia, ui-serif, serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "24px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "14px",
              maxWidth: "920px",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: "10px",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 14px",
                  borderRadius: "999px",
                  background: "#dbeafe",
                  color: "#1d4ed8",
                  fontSize: 20,
                  fontWeight: 700,
                }}
              >
                {truncate(params.courseName, 52)}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 14px",
                  borderRadius: "999px",
                  background: "#ffedd5",
                  color: "#c2410c",
                  fontSize: 18,
                  fontWeight: 700,
                }}
              >
                {truncate(params.weekLabel, 24)}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 54,
                  lineHeight: 1.08,
                  fontWeight: 800,
                  letterSpacing: "-0.03em",
                }}
              >
                {truncate(params.spec.headline, 90)}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 24,
                  lineHeight: 1.35,
                  color: "#475569",
                  maxWidth: "880px",
                }}
              >
                {truncate(params.spec.subtitle, 180)}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                width: "84px",
                height: "84px",
                borderRadius: "24px",
                background: "#1d4ed8",
                color: "#ffffff",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 34,
                fontWeight: 800,
              }}
            >
              U
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 22,
                color: "#1d4ed8",
                fontWeight: 700,
              }}
            >
              Ustad.ai
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "18px",
            marginTop: "28px",
          }}
        >
          {sections.map((section, index) => (
            <div
              key={`${section.heading}-${index}`}
              style={{
                display: "flex",
                flexDirection: "column",
                width: "calc(50% - 9px)",
                minHeight: "205px",
                borderRadius: "24px",
                background: "#ffffff",
                border: "1px solid rgba(148, 163, 184, 0.22)",
                boxShadow: "0 20px 50px rgba(15, 23, 42, 0.08)",
                padding: "24px 24px 22px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    width: "36px",
                    height: "36px",
                    borderRadius: "12px",
                    background: index % 2 === 0 ? "#dbeafe" : "#ffedd5",
                    color: index % 2 === 0 ? "#2563eb" : "#ea580c",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 18,
                    fontWeight: 800,
                  }}
                >
                  {index + 1}
                </div>
                <div
                  style={{
                    display: "flex",
                    fontSize: 25,
                    lineHeight: 1.2,
                    fontWeight: 700,
                    color: "#0f172a",
                  }}
                >
                  {section.heading}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {section.bullets.map((bullet, bulletIndex) => (
                  <div
                    key={`${section.heading}-${bulletIndex}`}
                    style={{
                      display: "flex",
                      gap: "12px",
                      alignItems: "flex-start",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        width: "10px",
                        height: "10px",
                        borderRadius: "999px",
                        background: index % 2 === 0 ? "#2563eb" : "#ea580c",
                        marginTop: "10px",
                        flexShrink: 0,
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        fontSize: 22,
                        lineHeight: 1.38,
                        color: "#334155",
                      }}
                    >
                      {bullet}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            marginTop: "18px",
            borderRadius: "24px",
            background: "#0f172a",
            color: "#f8fafc",
            padding: "22px 24px",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "18px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxWidth: "1040px",
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "#93c5fd",
              }}
            >
              Ana Çıkarım
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 24,
                lineHeight: 1.35,
                fontWeight: 600,
              }}
            >
              {truncate(params.spec.takeaway, 210)}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1344,
      height: 768,
    },
  );

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

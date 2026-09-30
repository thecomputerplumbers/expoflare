import { Link } from "expo-router"
import { Text, View } from "react-native"

export default function Home() {
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "600" }}>
        Expo on Cloudflare Workers
      </Text>
      <Link href="/users/ada">A dynamic route</Link>
      <Link href="/api/hello">An API route</Link>
    </View>
  )
}

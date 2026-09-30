import { useLocalSearchParams } from "expo-router"
import { Text, View } from "react-native"

export default function User() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return (
    <View style={{ padding: 24 }}>
      <Text>User: {id}</Text>
    </View>
  )
}
